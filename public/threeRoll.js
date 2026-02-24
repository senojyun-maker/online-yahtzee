import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

const overlay = document.getElementById("rollOverlay");
const canvas  = document.getElementById("threeCanvas");

// ===== lazy init（最初のopenで初期化） =====
let renderer, scene, camera, world;
let dice = [];
let rafId = null;

let dragging = false;
let lastX = 0, lastY = 0;
let power = 0;
let rollingCommitted = false;

// 物理安定化用
let lastTime = performance.now() / 1000;

// ===== チューニング値（好みに合わせてここを触る） =====
const CFG = {
  // ドラッグ→力変換（揺れ強め：枠内で暴れる）
  lateralScale: 0.012,
  upScale: 0.0022,
  upMax: 0.16,

  // 連打しすぎ防止（ms）
  applyIntervalMs: 22,

  // 速度・角速度の上限（枠内で十分暴れる）
  maxV: 9.0,
  maxW: 24.0,

  // 減衰（弱め＝揺れやすい）
  linearDamping: 0.16,
  angularDamping: 0.30,

  // ロール確定に必要なパワー
  commitPower: 95
};

// ===== 箱（枠）の寸法 =====
const BOX = {
  FLOOR_Y: 1.2,
  CEIL_Y:  7.2,
  HALF:    7.2
};

// （見た目の透明壁を作るなら true）
const SHOW_VISUAL_WALLS = false;

let lastApplyAt = 0;

// ===== 3Dダイス用：面マテリアル =====
let diceFaceMats = null;
let diceFaceMatsReady = false;

function buildDiceMaterials(){
  // 画像が無い/読み込み失敗でも落ちないように「白」も用意
  const fallback = new THREE.MeshStandardMaterial({ color: 0xffffff });

  const loader = new THREE.TextureLoader();

  function loadTex(url){
    try{
      const tex = loader.load(
        url,
        () => { diceFaceMatsReady = true; }, // 何か1枚でも読めたらOK扱い
        undefined,
        () => {} // エラーは無視（fallbackで表示）
      );

      // r160：色空間
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return tex;
    }catch{
      return null;
    }
  }

  const t1 = loadTex("dice-1.png");
  const t2 = loadTex("dice-2.png");
  const t3 = loadTex("dice-3.png");
  const t4 = loadTex("dice-4.png");
  const t5 = loadTex("dice-5.png");
  const t6 = loadTex("dice-6.png");

function matFrom(tex){
  if(!tex){
    return new THREE.MeshStandardMaterial({ color: 0xffffff });
  }

  return new THREE.MeshStandardMaterial({
    map: tex,
    color: 0xffffff,     // ★ダイス本体を白に固定
    transparent: true,   // ★透過有効
    alphaTest: 0.4       // ★黒フリンジ除去
  });
}

  // BoxGeometry の面順：+X, -X, +Y, -Y, +Z, -Z
  // 対面：1-6 / 2-5 / 3-4 を揃える例
  // +Y(上)=1, -Y(下)=6
  // +X=3, -X=4
  // +Z=2, -Z=5
  return [
    matFrom(t3), // +X
    matFrom(t4), // -X
    matFrom(t1), // +Y（上）
    matFrom(t6), // -Y（下）
    matFrom(t2), // +Z
    matFrom(t5)  // -Z
  ];
}

function initIfNeeded(){
  if(renderer) return;

  renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141414);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 6, 10);
  camera.lookAt(0, 2.4, 0);

  const amb = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(amb);

  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(5, 10, 5);
  scene.add(dir);

  // 物理
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.solver.iterations = 10;
  world.allowSleep = true;

  // 接触設定（跳ねすぎず、でも枠内で揺れる）
  world.defaultContactMaterial.friction = 0.42;
  world.defaultContactMaterial.restitution = 0.12;

  // ===== 床（上げる） =====
  const groundBody = new CANNON.Body({ mass: 0 });
  groundBody.addShape(new CANNON.Plane());
  groundBody.position.set(0, BOX.FLOOR_Y, 0);
  groundBody.quaternion.setFromEuler(-Math.PI/2, 0, 0);
  world.addBody(groundBody);

  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(20,20),
    new THREE.MeshStandardMaterial({ color: 0x2b2b2b })
  );
  groundMesh.rotation.x = -Math.PI/2;
  groundMesh.position.y = BOX.FLOOR_Y;
  scene.add(groundMesh);

  // ===== 天井（枠内に収める：当たり判定のみ） =====
  const ceilBody = new CANNON.Body({ mass: 0 });
  ceilBody.addShape(new CANNON.Plane());
  ceilBody.position.set(0, BOX.CEIL_Y, 0);
  ceilBody.quaternion.setFromEuler(Math.PI/2, 0, 0); // normal下向き
  world.addBody(ceilBody);

  // ===== 壁（左右＋前後：床の高さ基準で囲う） =====
  addWall( 0,       -BOX.HALF, 0,         BOX.FLOOR_Y); // 奥（z-）
  addWall( 0,        BOX.HALF, Math.PI,   BOX.FLOOR_Y); // 手前（z+）
  addWall(-BOX.HALF, 0,        Math.PI/2, BOX.FLOOR_Y); // 左（x-）
  addWall( BOX.HALF, 0,       -Math.PI/2, BOX.FLOOR_Y); // 右（x+）

  if(SHOW_VISUAL_WALLS){
    addVisualWalls();
  }

  // ★ 目付きマテリアルを一回だけ作る
  if(!diceFaceMats){
    diceFaceMats = buildDiceMaterials();
  }
}

function addWall(x, z, rotY, floorY){
  const b = new CANNON.Body({ mass: 0 });
  b.addShape(new CANNON.Plane());
  b.position.set(x, floorY, z);
  b.quaternion.setFromEuler(0, rotY, 0);
  world.addBody(b);
}

function addVisualWalls(){
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.06
  });

  const wallH = BOX.CEIL_Y - BOX.FLOOR_Y;
  const wallY = BOX.FLOOR_Y + wallH/2;

  const wallZ = new THREE.Mesh(new THREE.PlaneGeometry(BOX.HALF*2, wallH), wallMat);
  wallZ.position.set(0, wallY, -BOX.HALF);
  scene.add(wallZ);

  const wallZ2 = wallZ.clone();
  wallZ2.position.set(0, wallY, BOX.HALF);
  wallZ2.rotation.y = Math.PI;
  scene.add(wallZ2);

  const wallX = new THREE.Mesh(new THREE.PlaneGeometry(BOX.HALF*2, wallH), wallMat);
  wallX.position.set(-BOX.HALF, wallY, 0);
  wallX.rotation.y = Math.PI/2;
  scene.add(wallX);

  const wallX2 = wallX.clone();
  wallX2.position.set(BOX.HALF, wallY, 0);
  wallX2.rotation.y = -Math.PI/2;
  scene.add(wallX2);
}

function clearDice(){
  for(const d of dice){
    world.removeBody(d.body);
    scene.remove(d.mesh);
  }
  dice = [];
}

function createDice(){
  clearDice();

  for(let i=0;i<5;i++){
    // ★ 目付き（6面）を使う。読み込み失敗時は白になる。
    const geom = new THREE.BoxGeometry(1,1,1);
    const mesh = new THREE.Mesh(
      geom,
      diceFaceMats ?? new THREE.MeshStandardMaterial({ color: 0xffffff })
    );

    mesh.position.set(-2 + i*1.1, 4.0 + i*0.2, 0);
    scene.add(mesh);

    const body = new CANNON.Body({ mass: 1 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.5,0.5,0.5)));
    body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);

    body.angularDamping = CFG.angularDamping;
    body.linearDamping  = CFG.linearDamping;

    body.sleepSpeedLimit = 0.25;
    body.sleepTimeLimit = 0.25;

    world.addBody(body);
    dice.push({ mesh, body });
  }
}

function resize(){
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if(w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

function clampBody(body){
  const v = body.velocity;
  const vLen = v.length();
  if(vLen > CFG.maxV){
    v.scale(CFG.maxV / vLen, v);
  }

  const w = body.angularVelocity;
  const wLen = w.length();
  if(wLen > CFG.maxW){
    w.scale(CFG.maxW / wLen, w);
  }
}

function animate(){
  rafId = requestAnimationFrame(animate);
  resize();

  const now = performance.now() / 1000;
  let dt = now - lastTime;
  lastTime = now;
  if(dt > 0.05) dt = 0.05;

  world.step(1/60, dt, 3);

  for(const d of dice){
    clampBody(d.body);
    d.mesh.position.copy(d.body.position);
    d.mesh.quaternion.copy(d.body.quaternion);
  }

  renderer.render(scene, camera);
}

// ===== 操作：オーバーレイ全体でドラッグ検知 =====
function onPointerDown(e){
  if(rollingCommitted) return;
  dragging = true;
  power = 0;
  lastX = e.clientX;
  lastY = e.clientY;
  lastApplyAt = performance.now();
  overlay.setPointerCapture?.(e.pointerId);
}

function onPointerMove(e){
  if(!dragging || rollingCommitted) return;

  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;

  const dist = Math.hypot(dx, dy);
  power += Math.min(10, dist * 0.45);

  const nowMs = performance.now();
  if(nowMs - lastApplyAt < CFG.applyIntervalMs) return;
  lastApplyAt = nowMs;

  let ix = dx * CFG.lateralScale;
  let iz = -dy * CFG.lateralScale;

  let iy = Math.min(CFG.upMax, dist * CFG.upScale);

  const maxI = 0.32;
  const len = Math.hypot(ix, iz);
  if(len > maxI){
    const s = maxI / len;
    ix *= s; iz *= s;
  }

  for(const d of dice){
    const ox = (Math.random() - 0.5) * 0.35;
    const oy = (Math.random() - 0.5) * 0.35;
    const oz = (Math.random() - 0.5) * 0.35;
    const point = d.body.position.vadd(new CANNON.Vec3(ox, oy, oz));

    d.body.applyImpulse(
      new CANNON.Vec3(ix, iy, iz),
      point
    );
  }
}

function onPointerUp(e){
  if(!dragging || rollingCommitted) return;
  dragging = false;

  if(power >= CFG.commitPower){
    commitRoll();
  }
}

function commitRoll(){
  rollingCommitted = true;

  setTimeout(()=>{
    window.socket?.emit("roll");
    window.closeRollOverlay?.();
    rollingCommitted = false;
  }, 350);
}

function attachEvents(){
  overlay.onpointerdown = onPointerDown;
  overlay.onpointermove = onPointerMove;
  overlay.onpointerup   = onPointerUp;
  overlay.onpointercancel = onPointerUp;
}

function detachEvents(){
  overlay.onpointerdown = null;
  overlay.onpointermove = null;
  overlay.onpointerup   = null;
  overlay.onpointercancel = null;
}

// ===== 外部公開 =====
window.start3DRoll = function(){
  initIfNeeded();
  attachEvents();
  createDice();

  dragging = false;
  power = 0;
  rollingCommitted = false;

  lastTime = performance.now() / 1000;

  if(!rafId) animate();
};

window.stop3DRoll = function(){
  detachEvents();
  // ループ停止したいならここを有効化
  // if(rafId){ cancelAnimationFrame(rafId); rafId=null; }
};