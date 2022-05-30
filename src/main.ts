import {int, Tensor3, Vec3} from './base.js';
import {BlockId, Column, Env} from './engine.js';
import {kChunkWidth, kEmptyBlock, kWorldHeight} from './engine.js';
import {Component, ComponentState, ComponentStore, EntityId, kNoEntity} from './ecs.js';
import {sweep} from './sweep.js';

//////////////////////////////////////////////////////////////////////////////
// The game code:

class TypedEnv extends Env {
  position: ComponentStore<PositionState>;
  movement: ComponentStore<MovementState>;
  physics: ComponentStore<PhysicsState>;
  target: ComponentStore;

  constructor(id: string) {
    super(id);
    const ents = this.entities;
    this.position = ents.registerComponent('position', Position);
    this.movement = ents.registerComponent('movement', Movement(this));
    this.physics = ents.registerComponent('physics', Physics(this));
    this.target = ents.registerComponent('camera-target', CameraTarget(this));
  }
};

// An entity with a position is an axis-aligned bounding box (AABB) centered
// at (x, y, z), with x- and z-extents equal to w and y-extent equal to h.

interface PositionState {
  id: EntityId,
  index: int,
  x: number,
  y: number,
  z: number,
  h: number,
  w: number,
};

const Position: Component<PositionState> = {
  init: () => ({id: kNoEntity, index: 0, x: 0, y: 0, z: 0, h: 0, w: 0}),
};

// An entity's physics state tracks its location and velocity, and allows
// other systems to apply forces and impulses to it. It updates the entity's
// AABB and keeps its position in sync.

interface PhysicsState {
  id: EntityId,
  index: int,
  min: Vec3,
  max: Vec3,
  vel: Vec3,
  forces: Vec3,
  impulses: Vec3,
  resting: Vec3,
  inFluid: boolean,
  friction: number,
  mass: number,
  autoStep: number,
};

const kTmpGravity = Vec3.from(0, -40, 0);
const kTmpAcceleration = Vec3.create();
const kTmpFriction = Vec3.create();
const kTmpDelta = Vec3.create();
const kTmpSize = Vec3.create();
const kTmpPush = Vec3.create();
const kTmpMax = Vec3.create();
const kTmpMin = Vec3.create();
const kTmpPos = Vec3.create();
const kTmpResting = Vec3.create();

const setPhysicsFromPosition = (a: PositionState, b: PhysicsState) => {
  Vec3.set(kTmpPos, a.x, a.y, a.z);
  Vec3.set(kTmpSize, a.w / 2, a.h / 2, a.w / 2);
  Vec3.sub(b.min, kTmpPos, kTmpSize);
  Vec3.add(b.max, kTmpPos, kTmpSize);
};

const setPositionFromPhysics = (a: PositionState, b: PhysicsState) => {
  a.x = (b.min[0] + b.max[0]) / 2;
  a.y = (b.min[1] + b.max[1]) / 2;
  a.z = (b.min[2] + b.max[2]) / 2;
};

const applyFriction = (axis: int, state: PhysicsState, dv: Vec3) => {
  const resting = state.resting[axis];
  if (resting === 0 || resting * dv[axis] <= 0) return;

  Vec3.copy(kTmpFriction, state.vel);
  kTmpFriction[axis] = 0;
  const length = Vec3.length(kTmpFriction);
  if (length === 0) return;

  const loss = Math.abs(state.friction * dv[axis]);
  const scale = length < loss ? 0 : (length - loss) / length;
  state.vel[(axis + 1) % 3] *= scale;
  state.vel[(axis + 2) % 3] *= scale;
};

const tryAutoStepping =
    (dt: int, state: PhysicsState, min: Vec3, max: Vec3,
     check: (pos: Vec3) => boolean) => {
  if (state.resting[1] > 0 && !state.inFluid) return;

  const speed_x = Math.abs(state.vel[0]);
  const speed_z = Math.abs(state.vel[2]);
  const step_x = (state.resting[0] !== 0 && speed_x > speed_z);
  const step_z = (state.resting[2] !== 0 && speed_z > speed_x);
  if (!step_x && !step_z) return;

  const height = 1 - min[1] + Math.floor(min[1]);
  Vec3.set(kTmpDelta, 0, height, 0);
  sweep(min, max, kTmpDelta, kTmpResting, check);
  if (kTmpResting[1] !== 0) return;

  Vec3.scale(kTmpDelta, state.vel, dt);
  kTmpDelta[1] = 0;
  sweep(min, max, kTmpDelta, kTmpResting, check);
  if (min[0] === state.min[0] && min[2] === state.min[2]) return;

  if (height > state.autoStep) {
    Vec3.set(kTmpDelta, 0, state.autoStep, 0);
    sweep(state.min, state.max, kTmpDelta, state.resting, check);
    if (!step_x) state.vel[0] = 0;
    if (!step_z) state.vel[2] = 0;
    state.vel[1] = 0;
    return;
  }

  Vec3.copy(state.min, min);
  Vec3.copy(state.max, max);
  Vec3.copy(state.resting, kTmpResting);
};

const runPhysics = (env: TypedEnv, dt: int, state: PhysicsState) => {
  if (state.mass <= 0) return;

  const check = (pos: Vec3) => {
    const block = env.world.getBlock(pos[0], pos[1], pos[2]);
    return !env.registry.solid[block];
  };

  const [x, y, z] = state.min;
  const block = env.world.getBlock(
      Math.floor(x), Math.floor(y), Math.floor(z));
  state.inFluid = block !== kEmptyBlock;

  dt = dt / 1000;
  const drag = state.inFluid ? 2 : 0;
  const left = Math.max(1 - drag * dt, 0);
  const gravity = state.inFluid ? 0.25 : 1;

  Vec3.scale(kTmpAcceleration, state.forces, 1 / state.mass);
  Vec3.scaleAndAdd(kTmpAcceleration, kTmpAcceleration, kTmpGravity, gravity);
  Vec3.scale(kTmpDelta, kTmpAcceleration, dt);
  Vec3.scaleAndAdd(kTmpDelta, kTmpDelta, state.impulses, 1 / state.mass);
  if (state.friction) {
    applyFriction(0, state, kTmpDelta);
    applyFriction(1, state, kTmpDelta);
    applyFriction(2, state, kTmpDelta);
  }

  if (state.autoStep) {
    Vec3.copy(kTmpMax, state.max);
    Vec3.copy(kTmpMin, state.min);
  }

  // Update our state based on the computations above.
  Vec3.add(state.vel, state.vel, kTmpDelta);
  Vec3.scale(state.vel, state.vel, left);
  Vec3.scale(kTmpDelta, state.vel, dt);
  sweep(state.min, state.max, kTmpDelta, state.resting, check);
  Vec3.set(state.forces, 0, 0, 0);
  Vec3.set(state.impulses, 0, 0, 0);

  if (state.autoStep) {
    tryAutoStepping(dt, state, kTmpMin, kTmpMax, check);
  }

  for (let i = 0; i < 3; i++) {
    if (state.resting[i] !== 0) state.vel[i] = 0;
  }
};

const Physics = (env: TypedEnv): Component<PhysicsState> => ({
  init: () => ({
    id: kNoEntity,
    index: 0,
    min: Vec3.create(),
    max: Vec3.create(),
    vel: Vec3.create(),
    forces: Vec3.create(),
    impulses: Vec3.create(),
    resting: Vec3.create(),
    inFluid: false,
    friction: 0,
    mass: 1,
    autoStep: 0.25,
  }),
  onAdd: (state: PhysicsState) => {
    setPhysicsFromPosition(env.position.getX(state.id), state);
  },
  onRemove: (state: PhysicsState) => {
    setPositionFromPhysics(env.position.getX(state.id), state);
  },
  onRender: (dt: int, states: PhysicsState[]) => {
    for (const state of states) {
      setPositionFromPhysics(env.position.getX(state.id), state);
    }
  },
  onUpdate: (dt: int, states: PhysicsState[]) => {
    for (const state of states) runPhysics(env, dt, state);
  },
});

// Movement allows an entity to process inputs and attempt to move.

interface MovementState {
  id: EntityId,
  index: int,
  heading: number,
  running: boolean,
  jumping: boolean,
  maxSpeed: number,
  moveForce: number,
  swimPenalty: number,
  responsiveness: number,
  runningFriction: number,
  standingFriction: number,
  airMoveMultiplier: number,
  airJumps: number,
  jumpTime: number,
  jumpForce: number,
  jumpImpulse: number,
  _jumped: boolean,
  _jumpCount: number,
  _jumpTimeLeft: number,
};

const handleJumping =
    (dt: int, state: MovementState, body: PhysicsState, grounded: boolean) => {
  if (state._jumped) {
    if (state._jumpTimeLeft <= 0) return;
    const delta = state._jumpTimeLeft <= dt ? state._jumpTimeLeft / dt : 1;
    const force = state.jumpForce * delta;
    state._jumpTimeLeft -= dt;
    body.forces[1] += force;
    return;
  }

  const hasAirJumps = state._jumpCount < state.airJumps;
  const canJump = grounded || body.inFluid || hasAirJumps;
  if (!canJump) return;

  const height = body.min[1];
  const factor = height / kWorldHeight;
  const density = factor > 1 ? Math.exp(1 - factor) : 1;
  const penalty = body.inFluid ? state.swimPenalty : density;

  state._jumped = true;
  state._jumpTimeLeft = state.jumpTime;
  body.impulses[1] += state.jumpImpulse * penalty;
  if (grounded) return;

  body.vel[1] = Math.max(body.vel[1], 0);
  state._jumpCount++;
};

const handleRunning =
    (dt: int, state: MovementState, body: PhysicsState, grounded: boolean) => {
  const penalty = body.inFluid ? state.swimPenalty : 1;
  const speed = penalty * state.maxSpeed;
  Vec3.set(kTmpDelta, 0, 0, speed);
  Vec3.rotateY(kTmpDelta, kTmpDelta, state.heading);

  Vec3.sub(kTmpPush, kTmpDelta, body.vel);
  kTmpPush[1] = 0;
  const length = Vec3.length(kTmpPush);
  if (length === 0) return;

  const bound = state.moveForce * (grounded ? 1 : state.airMoveMultiplier);
  const input = state.responsiveness * length;
  Vec3.scale(kTmpPush, kTmpPush, Math.min(bound, input) / length);
  Vec3.add(body.forces, body.forces, kTmpPush);
};

const runMovement = (env: TypedEnv, dt: int, state: MovementState) => {
  dt = dt / 1000;

  // Process the inputs to get a heading, running, and jumping state.
  const inputs = env.container.inputs;
  const fb = (inputs.up ? 1 : 0) - (inputs.down ? 1 : 0);
  const lr = (inputs.right ? 1 : 0) - (inputs.left ? 1 : 0);
  state.running = fb !== 0 || lr !== 0;
  state.jumping = inputs.space;

  if (state.running) {
    let heading = env.renderer.camera.heading;
    if (fb) {
      if (fb === -1) heading += Math.PI;
      heading += fb * lr * Math.PI / 4;
    } else {
      heading += lr * Math.PI / 2;
    }
    state.heading = heading;
  }

  // All inputs processed; update the entity's PhysicsState.
  const body = env.physics.getX(state.id);
  const grounded = body.resting[1] < 0;
  if (grounded) state._jumpCount = 0;

  if (state.jumping) {
    handleJumping(dt, state, body, grounded);
  } else {
    state._jumped = false;
  }

  if (state.running) {
    handleRunning(dt, state, body, grounded);
    body.friction = state.runningFriction;
  } else {
    body.friction = state.standingFriction;
  }
};

const Movement = (env: TypedEnv): Component<MovementState> => ({
  init: () => ({
    id: kNoEntity,
    index: 0,
    heading: 0,
    running: false,
    jumping: false,
    maxSpeed: 10,
    moveForce: 30,
    swimPenalty: 0.5,
    responsiveness: 15,
    runningFriction: 0,
    standingFriction: 2,
    airMoveMultiplier: 0.5,
    airJumps: 9999,
    jumpTime: 0.2,
    jumpForce: 15,
    jumpImpulse: 10,
    _jumped: false,
    _jumpCount: 0,
    _jumpTimeLeft: 0,
  }),
  onUpdate: (dt: int, states: MovementState[]) => {
    for (const state of states) runMovement(env, dt, state);
  }
});

// CameraTarget signifies that the camera will follow an entity.

const CameraTarget = (env: TypedEnv): Component => ({
  init: () => ({id: kNoEntity, index: 0}),
  onRender: (dt: int, states: ComponentState[]) => {
    for (const state of states) {
      const {x, y, z, h} = env.position.getX(state.id);
      env.renderer.camera.setTarget(x, y + h / 3, z);
    }
  },
  onUpdate: (dt: int, states: ComponentState[]) => {
    for (const state of states) {
      const {x, y, z} = env.position.getX(state.id);
      env.world.recenter(x, y, z);
    }
  },
});

// Perlin noise implementation:

const perlin2D = () => {
  const getPermutation = (x: int): int[] => {
    const result = [];
    for (let i = 0; i < x; i++) {
      result.push(i);
      const idx = Math.floor(Math.random() * result.length);
      result[result.length - 1] = result[idx];
      result[idx] = i;
    }
    return result;
  };

  const count = 256;
  const table = getPermutation(count);
  table.slice().forEach(x => table.push(x));

  const gradients: [int, int][] = [];
  for (let i = 0; i < count; i++) {
    const angle = 2 * Math.PI * i / count;
    gradients.push([Math.cos(angle), Math.sin(angle)]);
  }

  const dot = (gradient: [int, int], x: number, y: number) => {
    return gradient[0] * x + gradient[1] * y;
  };

  const fade = (x: number): number => {
    return x * x * x * (x * (x * 6 - 15) + 10);
  };

  const lerp = (x: number, a: number, b: number): number => {
    return a + x * (b - a);
  };

  const noise = (x: number, y: number): number => {
    let ix = Math.floor(x);
    let iy = Math.floor(y);
    x -= ix;
    y -= iy;
    ix &= 255;
    iy &= 255;

    const g00 = table[ix +     table[iy    ]];
    const g10 = table[ix + 1 + table[iy    ]];
    const g01 = table[ix +     table[iy + 1]];
    const g11 = table[ix + 1 + table[iy + 1]];

    const n00 = dot(gradients[g00], x,     y    );
    const n10 = dot(gradients[g10], x - 1, y    );
    const n01 = dot(gradients[g01], x,     y - 1);
    const n11 = dot(gradients[g11], x - 1, y - 1);

    const fx = fade(x);
    const fy = fade(y);
    const y1 = lerp(fx, n00, n10);
    const y2 = lerp(fx, n01, n11);
    return lerp(fy, y1, y2);
  };

  return noise;
};

const fractalPerlin2D = (
    amplitude: number, radius: number, growth: number, count: int) => {
  const factor = Math.pow(2, growth);
  const components = new Array(count).fill(null).map(perlin2D);
  return (x: int, y: int): number => {
    let result = 0;
    let r = radius;
    let a = amplitude;
    for (const component of components) {
      result += a * component(x / r, y / r);
      a *= factor;
      r *= 2;
    }
    return result;
  };
};

// Putting it all together:

const main = () => {
  const env = new TypedEnv('container');
  const player = env.entities.addEntity();
  const position = env.position.add(player);
  position.x = 1;
  position.y = kWorldHeight;
  position.z = 1;
  position.w = 0.8;
  position.h = 1.6;

  env.physics.add(player);
  env.movement.add(player);
  env.target.add(player);

  const texture = (x: int, y: int, alphaTest: boolean = false) => {
    return {alphaTest, url: 'images/rhodox-edited.png', x, y, w: 16, h: 16};
  };

  const registry = env.registry;
  registry.addMaterialOfColor('blue', [0.1, 0.1, 0.4, 0.4], true);
  registry.addMaterialOfTexture(
    'water', texture(13, 13), [1, 1, 1, 0.8], true);
  registry.addMaterialOfTexture('leaves', texture(4, 3, true));
  const textures: [string, int, int][] = [
    ['bedrock', 1, 1],
    ['dirt', 2, 0],
    ['grass', 0, 0],
    ['grass-side', 3, 0],
    ['sand', 0, 11],
    ['snow', 2, 4],
    ['stone', 1, 0],
    ['trunk', 5, 1],
    ['trunk-side', 4, 1],
  ];
  for (const [name, x, y] of textures) {
    registry.addMaterialOfTexture(name, texture(x, y));
  }
  const rock = registry.addBlock(['stone'], true);
  const dirt = registry.addBlock(['dirt'], true);
  const sand = registry.addBlock(['sand'], true);
  const snow = registry.addBlock(['snow'], true);
  const grass = registry.addBlock(['grass', 'dirt', 'grass-side'], true);
  const bedrock = registry.addBlock(['bedrock'], true);
  const water = registry.addBlock(['water', 'blue', 'blue'], false);
  const trunk = registry.addBlock(['trunk', 'trunk-side'], true);
  const leaves = registry.addBlock(['leaves'], true);

  const H = kWorldHeight;
  const S = Math.floor(kWorldHeight / 2);
  const tiles: [BlockId, int][] =
    [[dirt, S - 2], [sand, S], [grass, S + 30], [dirt, S + 36], [snow, H]];

  const trees = perlin2D();
  const valleys = perlin2D();
  const roughness = perlin2D();
  const mountains = fractalPerlin2D(2, 8, 1.0, 6);
  const heightmap = (x: int, z: int): number => {
    const a = valleys(x / 64, z / 64);
    const b = roughness(x / 64, z / 64);
    const s = 1 / (1 + Math.exp(-16 * (Math.abs(a) / 0.04 - 1)));
    const t = 1 / (1 + Math.exp(-8 * (b - 0.1)));
    const m = t * mountains(x, z);
    const result = m > 0 ? m * s : m;
    return Math.max(Math.min(Math.round(result + H / 2), H), 0);
  };

  const tree = (x: int, z: int, height: int): boolean => {
    if (height <= S) return false;
    const result = trees(x / 17, z / 17);
    return (((result + 1) * 0x10000) & 0x3ff) <= 8 - height + S;
  };

  const kTrunkHeight = 4;
  const kTreeLeaves = 2;
  const kTreeRadius = 2;

  const kSideLength = kChunkWidth + 2 * kTreeRadius;
  const kChunkCache: int[] = new Array(2 * kSideLength * kSideLength).fill(0);
  let kLastCX = Number.NaN;
  let kLastCZ = Number.NaN;

  const loadChunk = (x: int, z: int, column: Column) => {
    const cx = Math.floor(x / kChunkWidth);
    const cz = Math.floor(z / kChunkWidth);
    const ax = cx * kChunkWidth - kTreeRadius;
    const az = cz * kChunkWidth - kTreeRadius;

    if (cx !== kLastCX || cz !== kLastCZ) {
      for (let i = 0; i < kSideLength; i++) {
        for (let j = 0; j < kSideLength; j++) {
          const index = i + kSideLength * j;
          const target = heightmap(ax + i, az + j);
          const has_tree = tree(ax + i, az + j, target);
          kChunkCache[2 * index + 0] = target;
          kChunkCache[2 * index + 1] = has_tree ? 1 : 0;
        }
      }
      kLastCX = cx;
      kLastCZ = cz;
    }

    const index = (x - ax) + kSideLength * (z - az);
    const target = kChunkCache[2 * index + 0];
    const has_tree = kChunkCache[2 * index + 1];

    for (const [tile, height] of tiles) {
      if (target > height) continue;
      column.push(rock, target - 4);
      column.push(dirt, target - 1);
      column.push(tile, target);
      column.push(water, S);

      if (has_tree) {
        column.push(trunk, target + kTrunkHeight);
        column.push(leaves, target + kTrunkHeight + 1);
      }
      for (let dx = -kTreeRadius; dx <= kTreeRadius; dx++) {
        for (let dz = -kTreeRadius; dz <= kTreeRadius; dz++) {
          if (dx === 0 && dz === 0) continue;
          const neighbor_index = index + dx + kSideLength * dz;
          const neighbor_target = kChunkCache[2 * neighbor_index + 0];
          const neighbor_has_tree = kChunkCache[2 * neighbor_index + 1];
          if (neighbor_has_tree) {
            const adjacent = Math.abs(dx) <= 1 && Math.abs(dz) <= 1;
            const start = neighbor_target + kTreeLeaves;
            const end = neighbor_target + kTrunkHeight  + (adjacent ? 1 : 0);
            column.push(kEmptyBlock, start);
            column.push(leaves, end);
          }
        }
      }
      return;
    }
  };

  const loadFrontier = (x: int, z: int, column: Column) => {
    const target = heightmap(x, z);
    for (const [tile, height] of tiles) {
      if (target > height) continue;
      column.push(tile, target);
      column.push(water, S);
      return;
    }
  };

  env.world.setLoader(bedrock, loadChunk, loadFrontier);

  const perlin = perlin2D();
  const loadChunkHack = (x: int, z: int, column: Column) => {
    const target = Math.round(8 * perlin(x / 16, z / 16) + S);
    column.push(dirt, Math.min(target, S - 1));
    column.push(sand, Math.min(target, S));
    column.push(grass, target);
  };

  //env.world.setLoader(bedrock, loadChunkHack);

  const ridgeNoise = (scale: number) => {
    const octaves = new Array(4).fill(null).map(perlin2D);
    return (x: int, z: int) => {
      let result = 0, a = 1, s = scale;
      for (const octave of octaves) {
        result += (1 - Math.abs(octave(x * s, z * s))) * a;
        a /= 2;
        s *= 2;
      }
      return result;
    };
  };
  const noiseA = ridgeNoise(0.005);
  const noiseB = ridgeNoise(0.005);
  const loadChunkRidge = (x: int, z: int, column: Column) => {
    const scale = 0.005;
    const target = (1 + 0.4 * (noiseA(x, z) - noiseB(x, z))) * S;
    column.push(dirt, Math.min(target, S - 1));
    column.push(sand, Math.min(target, S));
    column.push(grass, target);
  };

  //env.world.setLoader(bedrock, loadChunkRidge);

  env.refresh();
};

window.onload = main;

export {};
