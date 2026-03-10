import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

const overlay = document.getElementById("rollOverlay");
const canvas  = document.getElementById("threeCanvas");
const rollBox = document.getElementById("rollBox");

// ===== lazy init =====
let renderer, scene, camera, world;
let dice = [];
let rafId = null;

let dragging = false;
let startX = 0, startY = 0;
let lastX = 0, lastY = 0;
let lastMoveAt = 0;
let rollingCommitted = false;
let totalDragPower = 0;

// 物理安定化
let lastTime = performance.now() / 1000;

// ドラッグ速度
let dragVX = 0;
let dragVY = 0;

// ===== 設定 =====
const CFG = {
  // ドラッグ中の速度 -> ダイスへの力
  liveVelocityScale: 0.200,   // 横方向かなり強め
  liveUpScale: 0.0100,        // 速度に応じた上跳ね
  liveUpMax: 0.12,

  // 1回の適用上限
  liveMaxImpulse: 0.65,

  // 適用間隔
  applyIntervalMs: 16,

  // その場回転を抑える
  angularNudgeScale: 0.04,
  angularRandom: 0.65,

  // 最大速度上限
  maxLinearSpeed: 16,
  maxAngularSpeed: 8,

  // 減衰：移動は残す、回転は消しやすく
  linearDamping: 0.06,
  angularDamping: 0.30,

  // ある程度振ったらロール確定してよい
  commitPower: 120,

  // 見た目の揺れ
  boxMoveScale: 0.20,
  boxMoveMax: 100,
  boxRotateScale: 0.040,
  boxRotateMax: 10
};

// ===== 箱 =====
const BOX = {
  FLOOR_Y: 1.2,
  CEIL_Y:  7.2,
  HALF:    7.2
};

const SHOW_VISUAL_WALLS = false;
let lastApplyAt = 0;

// ===== ダイス面 =====
let diceFaceMats = null;

function buildDiceMaterials(){
  const loader = new THREE.TextureLoader();

  function loadTex(url){
    try{
      const tex = loader.load(url, undefined, undefined, () => {});
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
      color: 0xffffff,
      transparent: true,
      alphaTest: 0.4
    });
  }

  return [
    matFrom(t3), // +X
    matFrom(t4), // -X
    matFrom(t1), // +Y
    matFrom(t6), // -Y
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

  const amb = new THREE.AmbientLight(0xffffff, 0.95);
  scene.add(amb);

  const dir = new THREE.DirectionalLight(0xffffff, 0.75);
  dir.position.set(5, 10, 5);
  scene.add(dir);

  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -16, 0) });
  world.solver.iterations = 12;
  world.allowSleep = true;

  // 跳ね重視
  world.defaultContactMaterial.friction = 0.14;
  world.defaultContactMaterial.restitution = 0.48;

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

  const ceilBody = new CANNON.Body({ mass: 0 });
  ceilBody.addShape(new CANNON.Plane());
  ceilBody.position.set(0, BOX.CEIL_Y, 0);
  ceilBody.quaternion.setFromEuler(Math.PI/2, 0, 0);
  world.addBody(ceilBody);

const wallThickness = 0.35;
const wallHeight = (BOX.CEIL_Y - BOX.FLOOR_Y) / 2;
const wallCenterY = BOX.FLOOR_Y + wallHeight;

// 奥壁
addBoxWall(
  0,
  wallCenterY,
  -BOX.HALF,
  BOX.HALF,
  wallHeight,
  wallThickness
);

// 手前壁
addBoxWall(
  0,
  wallCenterY,
  BOX.HALF - 0.2,
  BOX.HALF,
  wallHeight,
  wallThickness
);

// 左壁
addBoxWall(
  -BOX.HALF,
  wallCenterY,
  0,
  wallThickness,
  wallHeight,
  BOX.HALF
);

// 右壁
addBoxWall(
  BOX.HALF,
  wallCenterY,
  0,
  wallThickness,
  wallHeight,
  BOX.HALF
);

  if(SHOW_VISUAL_WALLS){
    addVisualWalls();
  }

  if(!diceFaceMats){
    diceFaceMats = buildDiceMaterials();
  }
}

function addBoxWall(x, y, z, hx, hy, hz){
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
  body.position.set(x, y, z);
  world.addBody(body);

  if(SHOW_VISUAL_WALLS){
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.06
      })
    );
    mesh.position.set(x, y, z);
    scene.add(mesh);
  }
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
    const geom = new THREE.BoxGeometry(1,1,1);
    const mesh = new THREE.Mesh(
      geom,
      diceFaceMats ?? new THREE.MeshStandardMaterial({ color: 0xffffff })
    );

    mesh.position.set(
      -2.3 + i*1.15,
      4.2 + Math.random() * 0.4,
      (Math.random() - 0.5) * 1.8
    );
    scene.add(mesh);

    const body = new CANNON.Body({ mass: 1 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.5,0.5,0.5)));
    body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);

    body.angularDamping = CFG.angularDamping;
    body.linearDamping  = CFG.linearDamping;

    body.sleepSpeedLimit = 0.20;
    body.sleepTimeLimit = 0.35;

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
  if(vLen > CFG.maxLinearSpeed){
    v.scale(CFG.maxLinearSpeed / vLen, v);
  }

  const w = body.angularVelocity;
  const wLen = w.length();
  if(wLen > CFG.maxAngularSpeed){
    w.scale(CFG.maxAngularSpeed / wLen, w);
  }
}

function animate(){
  rafId = requestAnimationFrame(animate);
  resize();

  const now = performance.now() / 1000;
  let dt = now - lastTime;
  lastTime = now;
  if(dt > 0.05) dt = 0.05;

  world.step(1/60, dt, 4);

  for(const d of dice){
    clampBody(d.body);
    d.mesh.position.copy(d.body.position);
    d.mesh.quaternion.copy(d.body.quaternion);
  }

  renderer.render(scene, camera);
}

function clamp(n, min, max){
  return Math.max(min, Math.min(max, n));
}

function setRollBoxVisual(dx, dy){
  const moveX = clamp(dx * CFG.boxMoveScale, -CFG.boxMoveMax, CFG.boxMoveMax);
  const moveY = clamp(dy * CFG.boxMoveScale, -CFG.boxMoveMax, CFG.boxMoveMax);

  const rotY = clamp(dx * CFG.boxRotateScale, -CFG.boxRotateMax, CFG.boxRotateMax);
  const rotX = clamp(-dy * CFG.boxRotateScale, -CFG.boxRotateMax, CFG.boxRotateMax);

  rollBox.style.transform =
    `translate(${moveX}px, ${moveY}px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
}

function resetRollBoxVisual(){
  rollBox.style.transition = "transform 140ms ease-out";
  rollBox.style.transform = "translate(0px, 0px) rotateX(0deg) rotateY(0deg)";
  setTimeout(() => {
    rollBox.style.transition = "";
  }, 160);
}

function applyLiveShakeImpulse(dx, dy, dtMs){
  let ix = dx * CFG.liveVelocityScale;
  let iz = -dy * CFG.liveVelocityScale;

  const speed = Math.hypot(dx, dy);
  let iy = Math.min(CFG.liveUpMax, speed * CFG.liveUpScale);

  const planar = Math.hypot(ix, iz);
  if(planar > CFG.liveMaxImpulse){
    const s = CFG.liveMaxImpulse / planar;
    ix *= s;
    iz *= s;
  }

  for(const d of dice){
    // 速度を直接少し足す -> 箱に振られて飛ぶ感じ
    d.body.velocity.x += ix + (Math.random() - 0.5) * 0.9;
    d.body.velocity.y += iy + Math.random() * 0.25;
    d.body.velocity.z += iz + (Math.random() - 0.5) * 0.9;

    // 回転は弱め
    d.body.angularVelocity.x += (Math.random() - 0.5) * CFG.angularRandom + iz * CFG.angularNudgeScale;
    d.body.angularVelocity.y += (Math.random() - 0.5) * CFG.angularRandom;
    d.body.angularVelocity.z += (Math.random() - 0.5) * CFG.angularRandom + ix * CFG.angularNudgeScale;
  }

  totalDragPower += speed * 0.55;
}

// ===== 操作 =====
function onPointerDown(e){
  if(rollingCommitted) return;

  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  lastX = e.clientX;
  lastY = e.clientY;
  lastMoveAt = performance.now();
  totalDragPower = 0;
  dragVX = 0;
  dragVY = 0;

  rollBox.setPointerCapture?.(e.pointerId);
}

function onPointerMove(e){
  if(!dragging || rollingCommitted) return;

  const now = performance.now();
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  const dtMs = Math.max(1, now - lastMoveAt);

  lastX = e.clientX;
  lastY = e.clientY;
  lastMoveAt = now;

  const totalDx = e.clientX - startX;
  const totalDy = e.clientY - startY;

  setRollBoxVisual(totalDx, totalDy);

  dragVX = dx / dtMs;
  dragVY = dy / dtMs;

  const nowMs = performance.now();
  if(nowMs - lastApplyAt < CFG.applyIntervalMs) return;
  lastApplyAt = nowMs;

  applyLiveShakeImpulse(dx, dy, dtMs);
}

function onPointerUp(){
  if(!dragging || rollingCommitted) return;
  dragging = false;

  resetRollBoxVisual();

  if(totalDragPower >= CFG.commitPower){
    commitRoll();
  }
}

function commitRoll(){
  rollingCommitted = true;

  setTimeout(()=>{
    window.socket?.emit("roll");
    window.closeRollOverlay?.();
    rollingCommitted = false;
  }, 700);
}

function attachEvents(){
  rollBox.onpointerdown = onPointerDown;
  rollBox.onpointermove = onPointerMove;
  rollBox.onpointerup = onPointerUp;
  rollBox.onpointercancel = onPointerUp;
}

function detachEvents(){
  rollBox.onpointerdown = null;
  rollBox.onpointermove = null;
  rollBox.onpointerup = null;
  rollBox.onpointercancel = null;
}

// ===== 外部公開 =====
window.start3DRoll = function(){
  initIfNeeded();
  attachEvents();
  createDice();

  dragging = false;
  rollingCommitted = false;
  totalDragPower = 0;

  rollBox.style.transform = "translate(0px, 0px) rotateX(0deg) rotateY(0deg)";
  rollBox.style.transition = "";

  lastTime = performance.now() / 1000;

  if(!rafId) animate();
};

window.stop3DRoll = function(){
  detachEvents();
  dragging = false;
  rollBox.style.transform = "translate(0px, 0px) rotateX(0deg) rotateY(0deg)";
};