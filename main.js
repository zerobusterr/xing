import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

// --- 全局变量 ---
let scene, camera, renderer, controls;
let celestialBodies = {};
let orbitLines = {};
let trajectoryLines = {};
/** 模拟时间单位 = 太阳日：辉烬一次升落（赤道、与轨道同向共面时的上中天周期），由 daysPerRealSecond × timeSpeed 推进 */
let simulatedDays = 0;
let currentCameraTarget = 'Orbits';
let frameCount = 0;
let lastFpsTick = performance.now();
let prevFrameTime = performance.now();
let isRecording = false;
let trajectoryData = {};
let observerPosition = new THREE.Vector3();
let observerRotation = new THREE.Euler();

// 调试日志函数
function debugLog(message) {
    console.log(message);
    const debugEl = document.getElementById('debug');
    if (debugEl) {
        debugEl.innerHTML += message + '<br>';
        debugEl.scrollTop = debugEl.scrollHeight;
    }
}

// 配置参数 - 高自由度沙盒配置
const config = {
    /** 时间缩放：在 daysPerRealSecond 基础上再乘以此系数 */
    timeSpeed: 1.0,
    /** 真实时间每过 1 秒，模拟推进多少太阳日 */
    daysPerRealSecond: 1,
    /** 年长（太阳日）；纪年默认一圈 = 此值 */
    yearLengthDays: 365,
    /**
     * 为真时：辉烬、苍的公转周期由恒星日与故事比例联立推导，使 1 单位 simulatedDays = 1 太阳日。
     * 联立（自转与公转同向、共面）：1/T_辉烬 - 1/T_恒星 = 1（周期均以太阳日计）→ T_辉烬 = T_恒星/(T_恒星+1)
     */
    solarDayLink: true,
    /** 叙事参数：辉烬每公转一周，苍公转圈数 */
    story: {
        cangOrbitsPerHuijinOrbit: 2
    },
    orbitVisible: true,
    trajectoryVisible: false,
    recordingEnabled: false,

    /** 上帝视角与第一人称垂直视野（度），第一人称默认更宽以贴近「天幕」观感 */
    rendering: {
        fovDegreesGod: 60,
        fovDegreesObserver: 88
    },
    /** 环境光强度：压低后日夜对比主要由辉烬点光源体现 */
    ambientIntensity: 0.12,
    
    // 辉 (Hui) - 中心星体
    hui: {
        radius: 5,
        /** 恒星周期间隔：多少太阳日自转一周（相对恒星）；默认 = 年长/2，半年一周 */
        siderealDayDays: 182.5,
        siderealPhaseDeg: 0,
        color: 0x22aa88,
        emissiveIntensity: 0.18,
        visible: true
    },
    
    // 苍 (Cang) - 卫星（潮汐锁定；高 emissive 表现「恒为圆月、无圆缺」的设定亮度）
    cang: {
        radius: 1.5,
        orbitRadius: 15,
        /** 仅 solarDayLink 为 false 时用于公转；联立开启时由辉烬周期/故事比例推导 */
        orbitalPeriodDays: 0.497275,
        orbitPhaseDeg: 0,
        orbitInclination: 0,
        orbitLongitude: 0,
        color: 0xdddddd,
        emissiveIntensity: 0.9,
        visible: true
    },
    
    // 辉烬 (Hui Jin) - 主照明「太阳」
    huijin: {
        radius: 8,
        orbitRadius: 40,
        /** 仅 solarDayLink 为 false 时用于公转；联立开启时 T = T_恒星/(T_恒星+1) 太阳日/周 */
        orbitalPeriodDays: 0.99455,
        orbitPhaseDeg: 0,
        orbitInclination: 15,
        orbitLongitude: 0,
        color: 0xff4400,
        lightIntensity: 220,
        visible: true
    },
    
    // 纪年 (Ji Nian) - 年星；公转周期 = 年长 → 一圈一年
    jinian: {
        radius: 12,
        orbitRadius: 120,
        orbitalPeriodDays: 365,
        orbitPhaseDeg: 0,
        orbitInclination: 30,
        orbitLongitude: 45,
        color: 0x4444ff,
        lightIntensity: 55,
        visible: true
    },
    
    // 观察者设置
    observer: {
        /** 第一人称锚定星体：hui | cang | huijin | jinian */
        anchorBody: 'hui',
        latitude: 0,
        longitude: 0,
        height: 0.1,
        lookAzimuth: 0,
        lookAltitude: 0,
        coordinateSystem: 'horizon'
    }
};

function getSiderealPeriodSolarDays() {
    return Math.max(1e-9, config.hui.siderealDayDays);
}

/** 辉烬轨道周期（太阳日/周）；联立时满足与恒星日组合后太阳日=1 */
function getHuijinOrbitalPeriodSolarDays() {
    if (config.solarDayLink) {
        const Ts = getSiderealPeriodSolarDays();
        return Ts / (Ts + 1);
    }
    return Math.max(1e-9, config.huijin.orbitalPeriodDays);
}

function getCangOrbitalPeriodSolarDays() {
    if (config.solarDayLink) {
        return getHuijinOrbitalPeriodSolarDays() / Math.max(0.01, config.story.cangOrbitsPerHuijinOrbit);
    }
    return Math.max(1e-9, config.cang.orbitalPeriodDays);
}

const ANCHOR_LABELS = { hui: '辉星', cang: '苍', huijin: '辉烬', jinian: '纪年' };

/** 轨迹与天体信息中需显示的天体（不含当前锚点、且可见） */
function getObserverTargetBodyNames() {
    return ['hui', 'cang', 'huijin', 'jinian'].filter(
        (name) =>
            name !== config.observer.anchorBody &&
            celestialBodies[name] &&
            config[name].visible
    );
}

function getAnchorBodyWorldCenter(out) {
    if (config.observer.anchorBody === 'hui') {
        out.set(0, 0, 0);
        return out;
    }
    out.copy(celestialBodies[config.observer.anchorBody].position);
    return out;
}

/**
 * 根据锚点星体与经纬度，计算观察者世界坐标（写入 out）
 */
function getObserverWorldPosition(out) {
    const anchor = config.observer.anchorBody;
    const lat = (config.observer.latitude * Math.PI) / 180;
    const lon = (config.observer.longitude * Math.PI) / 180;
    const rBody = config[anchor].radius;
    const rh = rBody + config.observer.height;

    if (anchor === 'hui') {
        const rotationAngle = celestialBodies.hui.rotation.y;
        const effectiveLon = lon + rotationAngle;
        out.set(
            Math.cos(lat) * Math.sin(effectiveLon) * rh,
            Math.sin(lat) * rh,
            Math.cos(lat) * Math.cos(effectiveLon) * rh
        );
        return out;
    }

    const local = new THREE.Vector3(
        Math.cos(lat) * Math.sin(lon) * rh,
        Math.sin(lat) * rh,
        Math.cos(lat) * Math.cos(lon) * rh
    );

    if (anchor === 'cang') {
        const b = celestialBodies.cang;
        local.applyQuaternion(b.quaternion);
        out.copy(b.position).add(local);
        return out;
    }

    out.copy(celestialBodies[anchor].position).add(local);
    return out;
}

function applyCameraFov() {
    if (!camera) return;
    const deg =
        currentCameraTarget === 'observer'
            ? config.rendering.fovDegreesObserver
            : config.rendering.fovDegreesGod;
    camera.fov = deg;
    camera.updateProjectionMatrix();
}

function syncPointLightsFromConfig() {
    const hj = celestialBodies.huijin?.userData?.pointLight;
    if (hj) hj.intensity = config.huijin.lightIntensity;
    const jn = celestialBodies.jinian?.userData?.pointLight;
    if (jn) jn.intensity = config.jinian.lightIntensity;
}

function updateObserverAnchorLabel() {
    const el = document.getElementById('observer-anchor');
    if (el) el.textContent = ANCHOR_LABELS[config.observer.anchorBody] || config.observer.anchorBody;
}

// --- 初始化 ---
function init() {
    debugLog('开始初始化辉星系居住者视角系统...');
    
    try {
        // 1. 场景 - 纯黑宇宙背景
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);
        debugLog('场景创建成功 - 纯黑宇宙');
        
        // 2. 相机
        camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
        camera.position.set(0, 60, 100);
        debugLog('相机创建成功');

        // 3. 渲染器
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        
        document.body.appendChild(renderer.domElement);
        debugLog('渲染器创建成功');

        // 4. 控制器
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.minDistance = 5;
        controls.maxDistance = 800;
        controls.target.set(0, 0, 0);
        debugLog('控制器创建成功');

        // 5. 创建星体
        createCelestialBodies();

        // 6. 灯光
        setupLighting();

        // 7. GUI
        setupGUI();

        // 8. 事件监听
        window.addEventListener('resize', onWindowResize);
        
        debugLog(
            '初始化完成 — 时间单位为太阳日（辉烬升落）；联立时 T_辉烬=T_恒星/(T_恒星+1)，T_苍=T_辉烬/苍圈数比'
        );
        debugLog(
            `当前联立: T_恒星=${getSiderealPeriodSolarDays().toFixed(3)} 太阳日/周, T_辉烬=${getHuijinOrbitalPeriodSolarDays().toFixed(4)}, T_苍=${getCangOrbitalPeriodSolarDays().toFixed(4)} 太阳日/周`
        );
        
        // 隐藏加载界面，显示主界面
        document.getElementById('loading').style.display = 'none';
        document.getElementById('info').style.display = 'block';
        document.getElementById('gui-container').style.display = 'block';
        document.getElementById('celestial-info').style.display = 'block';
        document.getElementById('debug').style.display = 'block';
        
        prevFrameTime = performance.now();
        lastFpsTick = performance.now();
        // 开始动画循环
        animate();
        
    } catch (error) {
        debugLog('初始化失败: ' + error.message);
        console.error('初始化失败:', error);
        document.getElementById('loading').innerHTML = '<div style="color: red;">初始化失败: ' + error.message + '</div>';
    }
}

// --- 创建星体 ---
function createCelestialBodies() {
    debugLog('开始创建星体...');
    
    // 1. 辉 (Hui) - 中心星体
    const huiGeo = new THREE.SphereGeometry(config.hui.radius, 32, 32);
    const huiMat = new THREE.MeshStandardMaterial({ 
        color: config.hui.color,
        roughness: 0.8,
        metalness: 0.1,
        emissive: config.hui.color,
        emissiveIntensity: config.hui.emissiveIntensity
    });
    celestialBodies.hui = new THREE.Mesh(huiGeo, huiMat);
    celestialBodies.hui.castShadow = true;
    celestialBodies.hui.receiveShadow = true;
    scene.add(celestialBodies.hui);
    debugLog('辉星创建成功');

    // 2. 苍 (Cang) - 卫星
    const cangGeo = new THREE.SphereGeometry(config.cang.radius, 16, 16);
    const cangMat = new THREE.MeshStandardMaterial({ 
        color: config.cang.color,
        emissive: config.cang.color,
        emissiveIntensity: config.cang.emissiveIntensity,
        roughness: 0.9
    });
    celestialBodies.cang = new THREE.Mesh(cangGeo, cangMat);
    celestialBodies.cang.castShadow = true;
    celestialBodies.cang.receiveShadow = true;
    scene.add(celestialBodies.cang);
    debugLog('苍星创建成功');
    
    // 3. 辉烬 (Hui Jin) - 红巨星
    const huijinGeo = new THREE.SphereGeometry(config.huijin.radius, 24, 24);
    const huijinMat = new THREE.MeshBasicMaterial({ 
        color: config.huijin.color
    });
    celestialBodies.huijin = new THREE.Mesh(huijinGeo, huijinMat);
    scene.add(celestialBodies.huijin);
    
    // 辉烬的光源（主「日照」；强度可在 GUI 调）
    const huijinLight = new THREE.PointLight(config.huijin.color, config.huijin.lightIntensity, 800);
    huijinLight.castShadow = true;
    huijinLight.shadow.mapSize.width = 1024;
    huijinLight.shadow.mapSize.height = 1024;
    if ('decay' in huijinLight) huijinLight.decay = 1.8;
    celestialBodies.huijin.add(huijinLight);
    celestialBodies.huijin.userData.pointLight = huijinLight;
    debugLog('辉烬星创建成功');

    // 4. 纪年 (Ji Nian) - 蓝巨星
    const jinianGeo = new THREE.SphereGeometry(config.jinian.radius, 24, 24);
    const jinianMat = new THREE.MeshBasicMaterial({ 
        color: config.jinian.color
    });
    celestialBodies.jinian = new THREE.Mesh(jinianGeo, jinianMat);
    scene.add(celestialBodies.jinian);
    
    // 纪年的光源（远距高亮，辅助季节感；略弱于辉烬以免抢主照明）
    const jinianLight = new THREE.PointLight(config.jinian.color, config.jinian.lightIntensity, 2500);
    jinianLight.castShadow = true;
    jinianLight.shadow.mapSize.width = 512;
    jinianLight.shadow.mapSize.height = 512;
    if ('decay' in jinianLight) jinianLight.decay = 1.8;
    celestialBodies.jinian.add(jinianLight);
    celestialBodies.jinian.userData.pointLight = jinianLight;
    debugLog('纪年星创建成功');

    // 创建轨道线
    updateOrbitLines();
    
    debugLog('所有星体创建完成');
}

// --- 更新轨道线 ---
function updateOrbitLines() {
    // 清除现有轨道线
    Object.values(orbitLines).forEach(line => {
        scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
    });
    orbitLines = {};
    
    // 创建新的轨道线
    createOrbitLine('cang', config.cang.orbitRadius, 0x555555, config.cang.orbitInclination, config.cang.orbitLongitude);
    createOrbitLine('huijin', config.huijin.orbitRadius, 0xaa4400, config.huijin.orbitInclination, config.huijin.orbitLongitude);
    createOrbitLine('jinian', config.jinian.orbitRadius, 0x4444aa, config.jinian.orbitInclination, config.jinian.orbitLongitude);
}

function createOrbitLine(name, radius, color, inclination = 0, longitude = 0) {
    const points = [];
    const segments = 128;
    const inclinationRad = (inclination * Math.PI) / 180;
    const longitudeRad = (longitude * Math.PI) / 180;
    
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        let x = Math.cos(angle) * radius;
        let y = 0;
        let z = Math.sin(angle) * radius;
        
        // 应用轨道倾角
        if (inclination !== 0) {
            const newY = z * Math.sin(inclinationRad);
            const newZ = z * Math.cos(inclinationRad);
            y = newY;
            z = newZ;
        }
        
        // 应用轨道经度
        if (longitude !== 0) {
            const newX = x * Math.cos(longitudeRad) - z * Math.sin(longitudeRad);
            const newZ = x * Math.sin(longitudeRad) + z * Math.cos(longitudeRad);
            x = newX;
            z = newZ;
        }
        
        points.push(new THREE.Vector3(x, y, z));
    }
    
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ 
        color: color, 
        opacity: 0.6, 
        transparent: true,
        linewidth: 2
    });
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    orbitLines[name] = line;
}

// --- 灯光设置 ---
let ambientLightRef = null;
function setupLighting() {
    ambientLightRef = new THREE.AmbientLight(0x223344, config.ambientIntensity);
    scene.add(ambientLightRef);
    debugLog('灯光设置完成');
}

function applyAmbientFromConfig() {
    if (ambientLightRef) ambientLightRef.intensity = config.ambientIntensity;
}

// --- GUI 设置 ---
function setupGUI() {
    const gui = new GUI({ container: document.getElementById('gui-container') });
    
    // 模拟控制
    const simFolder = gui.addFolder('模拟控制');
    simFolder.add(config, 'timeSpeed', 0, 20, 0.1).name('时间流速倍率');
    simFolder.add(config, 'daysPerRealSecond', 0, 50, 0.05).name('太阳日/真实秒');
    simFolder.add(config, 'yearLengthDays', 1, 2000, 1).name('年长(太阳日)');
    const solarFolder = simFolder.addFolder('太阳日联立');
    solarFolder.add(config, 'solarDayLink').name('启用联立').onChange((v) => {
        debugLog(v ? '已启用：辉烬/苍周期由恒星日推导' : '已关闭：使用手动公转周期');
    });
    solarFolder.add(config.story, 'cangOrbitsPerHuijinOrbit', 0.5, 20, 0.5).name('苍/每辉烬圈');
    simFolder.add({
        resetVirtualTime: () => {
            simulatedDays = 0;
            debugLog('太阳历已重置为 0 太阳日');
        }
    }, 'resetVirtualTime').name('重置太阳历');
    simFolder.add({
        setCangTwicePerHuijin: () => {
            config.story.cangOrbitsPerHuijinOrbit = 2;
            debugLog('故事比例：辉烬每绕辉一圈，苍绕两圈（苍/每辉烬圈=2）');
        }
    }, 'setCangTwicePerHuijin').name('苍=每辉烬圈×2');
    simFolder.add({
        syncHuiHalfYearRotation: () => {
            config.hui.siderealDayDays = Math.max(0.05, config.yearLengthDays / 2);
            debugLog(`辉恒星周期间隔已设为半年：${config.hui.siderealDayDays} 太阳日/周`);
        }
    }, 'syncHuiHalfYearRotation').name('辉自转=半年/周');
    simFolder.add({
        syncJinianOrbitalYear: () => {
            config.jinian.orbitalPeriodDays = Math.max(1, config.yearLengthDays);
            debugLog(`纪年公转周期已设为与年长相同：${config.jinian.orbitalPeriodDays} 太阳日`);
        }
    }, 'syncJinianOrbitalYear').name('纪年周期=年长');
    simFolder.add(config, 'ambientIntensity', 0, 0.5, 0.01).name('环境光').onChange(applyAmbientFromConfig);
    simFolder.add(config, 'orbitVisible').name('显示轨道').onChange(v => {
        Object.values(orbitLines).forEach(line => line.visible = v);
    });
    simFolder.add(config, 'trajectoryVisible').name('显示轨迹').onChange(v => {
        Object.values(trajectoryLines).forEach(line => line.visible = v);
    });
    
    // 视角控制
    const renderFolder = gui.addFolder('渲染');
    renderFolder.add(config.rendering, 'fovDegreesGod', 40, 100, 1).name('上帝视角FOV°').onChange(() => {
        if (currentCameraTarget === 'Orbits') applyCameraFov();
    });
    renderFolder.add(config.rendering, 'fovDegreesObserver', 55, 120, 1).name('第一人称FOV°').onChange(() => {
        if (currentCameraTarget === 'observer') applyCameraFov();
    });

    const viewFolder = gui.addFolder('视角控制');
    const viewOptions = {
        '上帝视角 (自由)': 'Orbits',
        '第一人称观测': 'observer'
    };
    
    viewFolder.add({ currentView: 'Orbits' }, 'currentView', viewOptions)
        .name('当前视角')
        .onChange(value => {
            currentCameraTarget = value;
            updateViewMode();
        });
    
    // 观察者设置
    const observerFolder = gui.addFolder('观察者设置');
    const anchorOptions = {
        辉星: 'hui',
        苍: 'cang',
        辉烬: 'huijin',
        纪年: 'jinian'
    };
    observerFolder
        .add(config.observer, 'anchorBody', anchorOptions)
        .name('观测锚点')
        .onChange(() => {
            updateObserverAnchorLabel();
            updateObserverView();
        });
    observerFolder.add(config.observer, 'latitude', -90, 90, 1).name('纬度').onChange(updateObserverView);
    observerFolder.add(config.observer, 'longitude', -180, 180, 1).name('经度').onChange(updateObserverView);
    observerFolder.add(config.observer, 'height', 0.01, 2, 0.01).name('观察高度').onChange(updateObserverView);
    observerFolder.add(config.observer, 'lookAzimuth', -180, 180, 1).name('观察方位角').onChange(updateObserverView);
    observerFolder.add(config.observer, 'lookAltitude', -90, 90, 1).name('观察高度角').onChange(updateObserverView);
    
    const huiFolder = gui.addFolder('辉星 (自转)');
    huiFolder.add(config.hui, 'siderealDayDays', 0.05, 800, 0.05).name('恒星周期间隔(太阳日/周)');
    huiFolder.add(config.hui, 'siderealPhaseDeg', -180, 180, 1).name('自转初相°');
    huiFolder.add(config.hui, 'emissiveIntensity', 0, 1, 0.02).name('自发光').onChange((v) => {
        if (celestialBodies.hui?.material?.emissiveIntensity !== undefined) {
            celestialBodies.hui.material.emissiveIntensity = v;
        }
    });
    
    // 轨道参数
    const orbitFolder = gui.addFolder('轨道参数');
    
    // 苍的轨道参数
    const cangFolder = orbitFolder.addFolder('苍 (Cang)');
    cangFolder.add(config.cang, 'orbitRadius', 5, 50, 0.5).name('轨道半径').onChange(updateOrbitLines);
    cangFolder.add(config.cang, 'orbitalPeriodDays', 0.05, 50, 0.005).name('公转周期(仅联立关闭)');
    cangFolder.add(config.cang, 'orbitPhaseDeg', -180, 180, 1).name('轨道初相°');
    cangFolder.add(config.cang, 'orbitInclination', -90, 90, 1).name('轨道倾角').onChange(updateOrbitLines);
    cangFolder.add(config.cang, 'orbitLongitude', -180, 180, 1).name('轨道经度').onChange(updateOrbitLines);
    cangFolder.add(config.cang, 'emissiveIntensity', 0, 2, 0.05).name('圆月亮度').onChange((v) => {
        if (celestialBodies.cang?.material?.emissiveIntensity !== undefined) {
            celestialBodies.cang.material.emissiveIntensity = v;
        }
    });
    cangFolder.add(config.cang, 'visible').name('可见性').onChange(v => {
        celestialBodies.cang.visible = v;
    });
    
    // 辉烬的轨道参数
    const huijinFolder = orbitFolder.addFolder('辉烬 (Hui Jin)');
    huijinFolder.add(config.huijin, 'orbitRadius', 10, 100, 1).name('轨道半径').onChange(updateOrbitLines);
    huijinFolder.add(config.huijin, 'orbitalPeriodDays', 0.05, 50, 0.005).name('公转周期(仅联立关闭)');
    huijinFolder.add(config.huijin, 'orbitPhaseDeg', -180, 180, 1).name('轨道初相°');
    huijinFolder.add(config.huijin, 'orbitInclination', -90, 90, 1).name('轨道倾角').onChange(updateOrbitLines);
    huijinFolder.add(config.huijin, 'orbitLongitude', -180, 180, 1).name('轨道经度').onChange(updateOrbitLines);
    huijinFolder.add(config.huijin, 'lightIntensity', 0, 400, 1).name('主照明强度').onChange(syncPointLightsFromConfig);
    huijinFolder.add(config.huijin, 'visible').name('可见性').onChange(v => {
        celestialBodies.huijin.visible = v;
    });
    
    // 纪年的轨道参数
    const jinianFolder = orbitFolder.addFolder('纪年 (Ji Nian)');
    jinianFolder.add(config.jinian, 'orbitRadius', 50, 300, 5).name('轨道半径').onChange(updateOrbitLines);
    jinianFolder.add(config.jinian, 'orbitalPeriodDays', 10, 2000, 1).name('公转周期(太阳日/周)');
    jinianFolder.add(config.jinian, 'orbitPhaseDeg', -180, 180, 1).name('轨道初相°');
    jinianFolder.add(config.jinian, 'orbitInclination', -90, 90, 1).name('轨道倾角').onChange(updateOrbitLines);
    jinianFolder.add(config.jinian, 'orbitLongitude', -180, 180, 1).name('轨道经度').onChange(updateOrbitLines);
    jinianFolder.add(config.jinian, 'lightIntensity', 0, 200, 1).name('光强').onChange(syncPointLightsFromConfig);
    jinianFolder.add(config.jinian, 'visible').name('可见性').onChange(v => {
        celestialBodies.jinian.visible = v;
    });
    
    // 轨迹记录
    const trajectoryFolder = gui.addFolder('轨迹记录');
    trajectoryFolder.add(config, 'recordingEnabled').name('启用记录');
    trajectoryFolder.add({ startRecording: startRecording }, 'startRecording').name('开始记录');
    trajectoryFolder.add({ stopRecording: stopRecording }, 'stopRecording').name('停止记录');
    trajectoryFolder.add({ clearTrajectories: clearTrajectories }, 'clearTrajectories').name('清除轨迹');
    
    gui.close();
}

// --- 视角模式更新 ---
function updateViewMode() {
    if (currentCameraTarget === 'Orbits') {
        controls.enabled = true;
        controls.target.set(0, 0, 0);
        document.getElementById('info').classList.remove('observer-mode');
        document.getElementById('celestial-info').style.display = 'none';
    } else if (currentCameraTarget === 'observer') {
        controls.enabled = false;
        document.getElementById('info').classList.add('observer-mode');
        document.getElementById('celestial-info').style.display = 'block';
        updateObserverAnchorLabel();
        updateObserverView();
    }
    applyCameraFov();
    
    const viewNames = {
        'Orbits': '上帝视角',
        'observer': '第一人称观测'
    };
    document.getElementById('current-view').innerText = viewNames[currentCameraTarget];
}

// --- 观察者视角更新 ---
function updateObserverView() {
    if (currentCameraTarget !== 'observer') return;

    const bodyCenter = new THREE.Vector3();
    getAnchorBodyWorldCenter(bodyCenter);
    getObserverWorldPosition(observerPosition);

    camera.position.copy(observerPosition);

    const lookAzimuth = (config.observer.lookAzimuth * Math.PI) / 180;
    const lookAltitude = (config.observer.lookAltitude * Math.PI) / 180;

    const lookDirection = new THREE.Vector3(
        Math.cos(lookAltitude) * Math.sin(lookAzimuth),
        Math.sin(lookAltitude),
        Math.cos(lookAltitude) * Math.cos(lookAzimuth)
    );

    const localUp = observerPosition.clone().sub(bodyCenter).normalize();
    const worldNorthRef = new THREE.Vector3(0, 1, 0);
    let localEast = new THREE.Vector3().crossVectors(worldNorthRef, localUp);
    if (localEast.lengthSq() < 1e-10) {
        localEast.set(1, 0, 0);
    } else {
        localEast.normalize();
    }
    const localNorth = new THREE.Vector3().crossVectors(localUp, localEast).normalize();

    const worldDirection = new THREE.Vector3()
        .addScaledVector(localEast, lookDirection.x)
        .addScaledVector(localNorth, lookDirection.y)
        .addScaledVector(localUp, lookDirection.z);

    camera.lookAt(observerPosition.clone().add(worldDirection));

    document.getElementById('observer-position').innerText =
        `${ANCHOR_LABELS[config.observer.anchorBody]} · 纬度${config.observer.latitude}°, 经度${config.observer.longitude}°`;
    
    // 计算并显示天体信息
    const celestialInfo = calculateCelestialPositions();
    updateCelestialInfo(celestialInfo);
    updateTrajectoryRecording(celestialInfo);
}

// --- 计算天体位置 ---
function calculateCelestialPositions() {
    const info = {};

    getObserverTargetBodyNames().forEach((name) => {
        if (!celestialBodies[name] || !config[name].visible) return;
        
        const bodyPos = celestialBodies[name].position;
        const observerToBody = bodyPos.clone().sub(observerPosition);
        const distance = observerToBody.length();
        const direction = observerToBody.normalize();
        
        // 计算高度角（相对于地平线）
        const localUp = observerPosition.clone().normalize();
        const altitude = Math.asin(direction.dot(localUp)) * 180 / Math.PI;
        
        // 计算方位角（相对于北方）
        const localNorth = new THREE.Vector3(0, 1, 0);
        const localEast = new THREE.Vector3().crossVectors(localNorth, localUp).normalize();
        
        // 投影到地平面上
        const horizontalDirection = direction.clone().sub(localUp.clone().multiplyScalar(direction.dot(localUp)));
        const azimuth = Math.atan2(
            horizontalDirection.dot(localEast),
            horizontalDirection.dot(localNorth)
        ) * 180 / Math.PI;
        
        info[name] = {
            altitude: altitude,
            azimuth: azimuth,
            distance: distance,
            visible: altitude > -5, // 考虑大气折射
            position: bodyPos.clone(),
            direction: direction.clone()
        };
    });
    
    return info;
}

// --- 更新天体信息显示 ---
function updateCelestialInfo(info) {
    let infoText = '<h4>天体位置信息</h4>';
    let visibleCount = 0;
    const names = getObserverTargetBodyNames();

    names.forEach((name) => {
        if (info[name]) {
            const data = info[name];
            const status = data.visible ? '🟢 可见' : '🔴 不可见';
            const label = ANCHOR_LABELS[name] || name;
            infoText += `<div style="margin: 5px 0;">`;
            infoText += `<strong>${label}:</strong><br>`;
            infoText += `高度: ${data.altitude.toFixed(1)}°<br>`;
            infoText += `方位: ${data.azimuth.toFixed(1)}°<br>`;
            infoText += `距离: ${data.distance.toFixed(1)}<br>`;
            infoText += `状态: ${status}`;
            infoText += `</div><hr style="margin: 5px 0; border-color: #333;">`;
            
            if (data.visible) visibleCount++;
        }
    });
    
    infoText += `<div style="margin-top: 10px; font-size: 10px;">可见天体: ${visibleCount}/${names.length}</div>`;
    
    document.getElementById('celestial-data').innerHTML = infoText;
}

// --- 轨迹记录功能（专门针对自转影响）---
function startRecording() {
    isRecording = true;
    trajectoryData = {};
    getObserverTargetBodyNames().forEach((name) => {
        trajectoryData[name] = {
            positions: [],
            altitudes: [],
            azimuths: [],
            timestamps: []
        };
    });
    debugLog('开始记录轨迹 - 专注于自转影响分析');
}

function stopRecording() {
    isRecording = false;
    debugLog('停止记录轨迹');
    
    // 分析轨迹数据
    if (Object.keys(trajectoryData).length > 0) {
        analyzeTrajectoryData();
    }
}

function clearTrajectories() {
    Object.values(trajectoryLines).forEach(line => {
        scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
    });
    trajectoryLines = {};
    trajectoryData = {};
    debugLog('清除所有轨迹');
}

function updateTrajectoryRecording(celestialInfo) {
    if (!isRecording) return;

    getObserverTargetBodyNames().forEach((name) => {
        if (!trajectoryData[name] || !celestialInfo[name]) return;
        const data = celestialInfo[name];
        trajectoryData[name].positions.push(data.position.clone());
        trajectoryData[name].altitudes.push(data.altitude);
        trajectoryData[name].azimuths.push(data.azimuth);
        trajectoryData[name].timestamps.push(simulatedDays);

        if (trajectoryData[name].positions.length > 500) {
            trajectoryData[name].positions.shift();
            trajectoryData[name].altitudes.shift();
            trajectoryData[name].azimuths.shift();
            trajectoryData[name].timestamps.shift();
        }
    });
    
    // 更新轨迹可视化
    if (config.trajectoryVisible) {
        updateTrajectoryVisualization();
    }
}

function updateTrajectoryVisualization() {
    Object.keys(trajectoryData).forEach(name => {
        const data = trajectoryData[name];
        if (data.positions.length < 2) return;
        
        // 清除旧的轨迹线
        if (trajectoryLines[name]) {
            scene.remove(trajectoryLines[name]);
            trajectoryLines[name].geometry.dispose();
            trajectoryLines[name].material.dispose();
        }
        
        // 创建新的轨迹线
        const geometry = new THREE.BufferGeometry().setFromPoints(data.positions);
        const material = new THREE.LineBasicMaterial({ 
            color: config[name].color, 
            opacity: 0.8, 
            transparent: true,
            linewidth: 3
        });
        trajectoryLines[name] = new THREE.Line(geometry, material);
        scene.add(trajectoryLines[name]);
    });
}

function analyzeTrajectoryData() {
    debugLog('=== 轨迹分析结果 ===');
    
    Object.keys(trajectoryData).forEach(name => {
        const data = trajectoryData[name];
        if (data.altitudes.length < 10) return;
        
        debugLog(`\n--- ${name} 轨迹分析 ---`);
        
        // 计算高度变化范围
        const maxAlt = Math.max(...data.altitudes);
        const minAlt = Math.min(...data.altitudes);
        const altRange = maxAlt - minAlt;
        
        // 计算方位变化范围
        const maxAz = Math.max(...data.azimuths);
        const minAz = Math.min(...data.azimuths);
        const azRange = maxAz - minAz;
        
        // 计算可见时间比例
        const visibleCount = data.altitudes.filter(alt => alt > -5).length;
        const visibilityRatio = visibleCount / data.altitudes.length;
        
        debugLog(`高度范围: ${minAlt.toFixed(1)}° ~ ${maxAlt.toFixed(1)}° (变化: ${altRange.toFixed(1)}°)`);
        debugLog(`方位范围: ${minAz.toFixed(1)}° ~ ${maxAz.toFixed(1)}° (变化: ${azRange.toFixed(1)}°)`);
        const t0 = data.timestamps[0];
        const t1 = data.timestamps[data.timestamps.length - 1];
        debugLog(`可见时间比例: ${(visibilityRatio * 100).toFixed(1)}%`);
        if (t0 !== undefined && t1 !== undefined) {
            debugLog(`记录太阳日区间: ${t0.toFixed(2)} ~ ${t1.toFixed(2)} 太阳日`);
        }
        
        // 分析运动模式
        if (altRange > 10) {
            debugLog('运动模式: 明显的升降运动');
        } else {
            debugLog('运动模式: 主要水平运动');
        }
    });
}

// --- 窗口调整 ---
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function updateSimTimeDisplay() {
    const el = document.getElementById('sim-time');
    const yEl = document.getElementById('sim-day-of-year');
    if (el) el.textContent = `${simulatedDays.toFixed(2)} 太阳日`;
    if (yEl) {
        const yl = Math.max(1, config.yearLengthDays);
        const dof = ((simulatedDays % yl) + yl) % yl;
        yEl.textContent = `第 ${Math.floor(dof) + 1} 日 / ${yl} 日`;
    }
    const hjEl = document.getElementById('huijin-period-display');
    const cgEl = document.getElementById('cang-period-display');
    if (hjEl) hjEl.textContent = getHuijinOrbitalPeriodSolarDays().toFixed(4);
    if (cgEl) cgEl.textContent = getCangOrbitalPeriodSolarDays().toFixed(4);
}

// --- 动画循环 ---
function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const deltaSec = Math.min(Math.max((now - prevFrameTime) / 1000, 0), 0.25);
    prevFrameTime = now;

    simulatedDays += deltaSec * config.daysPerRealSecond * config.timeSpeed;

    frameCount++;
    if (now - lastFpsTick >= 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTick));
        document.getElementById('fps').textContent = fps;
        frameCount = 0;
        lastFpsTick = now;
    }

    updateSimTimeDisplay();

    // 更新星体位置
    updateCelestialBodies();
    syncPointLightsFromConfig();

    // 更新观察者视角
    if (currentCameraTarget === 'observer') {
        updateObserverView();
    }
    
    // 更新季节显示
    updateSeasonDisplay();

    // 渲染
    if (controls.enabled) {
        controls.update();
    }
    renderer.render(scene, camera);
}

function updateCelestialBodies() {
    // 辉 (Hui) 自转：simulatedDays 为太阳日，恒星周期间隔 siderealDayDays 亦以太阳日计
    if (celestialBodies.hui && config.hui.visible) {
        const sidereal = Math.max(1e-6, config.hui.siderealDayDays);
        const phase = (config.hui.siderealPhaseDeg * Math.PI) / 180;
        celestialBodies.hui.rotation.y = Math.PI * 2 * (simulatedDays / sidereal) + phase;
    }

    // 更新其他星体位置（辉烬、苍周期在联立下由太阳日定义推导）
    const bodies = ['cang', 'huijin', 'jinian'];
    bodies.forEach(name => {
        if (!celestialBodies[name] || !config[name].visible) return;
        
        const body = celestialBodies[name];
        const cfg = config[name];
        
        let period;
        if (name === 'huijin') period = getHuijinOrbitalPeriodSolarDays();
        else if (name === 'cang') period = getCangOrbitalPeriodSolarDays();
        else period = Math.max(1e-6, cfg.orbitalPeriodDays);
        const orbitPhase = (cfg.orbitPhaseDeg * Math.PI) / 180;
        const angle = Math.PI * 2 * (simulatedDays / period) + orbitPhase;
        let x = Math.cos(angle) * cfg.orbitRadius;
        let y = 0;
        let z = Math.sin(angle) * cfg.orbitRadius;
        
        // 应用轨道倾角和经度
        const inclinationRad = (cfg.orbitInclination * Math.PI) / 180;
        const longitudeRad = (cfg.orbitLongitude * Math.PI) / 180;
        
        if (inclinationRad !== 0) {
            const newY = z * Math.sin(inclinationRad);
            const newZ = z * Math.cos(inclinationRad);
            y = newY;
            z = newZ;
        }
        
        if (longitudeRad !== 0) {
            const newX = x * Math.cos(longitudeRad) - z * Math.sin(longitudeRad);
            const newZ = x * Math.sin(longitudeRad) + z * Math.cos(longitudeRad);
            x = newX;
            z = newZ;
        }
        
        body.position.set(x, y, z);
        
        // 潮汐锁定：苍始终面向辉
        if (name === 'cang') {
            body.lookAt(0, 0, 0);
        }
    });
}

function updateSeasonDisplay() {
    const el = document.getElementById('current-season');
    if (!el) return;

    if (!celestialBodies.jinian || !config.jinian.visible) {
        el.innerText = '纪年星不可见 / 已关闭';
        el.style.color = '#888888';
        return;
    }

    const jinianPos = celestialBodies.jinian.position;

    /** 纪年相对观察点的高度角（度）；仅在辉星锚点第一人称时代表「半球季节」 */
    let altDeg = null;
    if (currentCameraTarget === 'observer' && config.observer.anchorBody === 'hui') {
        const toJ = jinianPos.clone().sub(observerPosition);
        const len = toJ.length();
        if (len > 1e-6) {
            const dir = toJ.multiplyScalar(1 / len);
            const bodyCenter = new THREE.Vector3(0, 0, 0);
            const localUp = observerPosition.clone().sub(bodyCenter).normalize();
            altDeg = Math.asin(Math.max(-1, Math.min(1, dir.dot(localUp)))) * (180 / Math.PI);
        }
    }

    if (altDeg !== null) {
        const yl = Math.max(1e-6, config.yearLengthDays);
        const dayInYear = ((simulatedDays % yl) + yl) % yl;
        const midYear = yl / 2;
        const nearMeridian =
            altDeg > 25 && altDeg < 85 && Math.abs(dayInYear - midYear) < yl * 0.08;

        if (altDeg > 32) {
            el.innerText = nearMeridian
                ? '暖季 · 纪年近天顶（年度中点附近）'
                : '暖季（纪年高悬，半球主暖周期）';
            el.style.color = '#ffaa00';
        } else if (altDeg < -6) {
            el.innerText = '寒季（纪年在地平下或极低）';
            el.style.color = '#aaddff';
        } else {
            el.innerText = '过渡季 / 寒暑交替';
            el.style.color = '#ffffff';
        }
        return;
    }

    // 上帝视角：用纪年轨道倾角与年内相位的简化示意
    const yl = Math.max(1e-6, config.yearLengthDays);
    const phase = ((simulatedDays % yl) + yl) % yl;
    const orbitHalf = yl * 0.5;
    const decl = jinianPos.y / Math.max(jinianPos.length(), 1e-6);

    if (decl > 0.25 && phase < orbitHalf) {
        el.innerText = '示意：暖半球周期（上帝视角）';
        el.style.color = '#ffaa00';
    } else if (decl < -0.2 || phase >= orbitHalf) {
        el.innerText = '示意：寒半球 / 下半年（上帝视角）';
        el.style.color = '#aaddff';
    } else {
        el.innerText = '示意：过渡（上帝视角）';
        el.style.color = '#ffffff';
    }
}

// 启动应用
debugLog('正在启动辉星系居住者视角系统...');
init();