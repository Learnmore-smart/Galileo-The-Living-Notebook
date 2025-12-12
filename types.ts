export interface Point {
  x: number;
  y: number;
}

export interface BodyDef {
  id: string;
  type: 'circle' | 'rectangle';
  x: number;
  y: number;
  width?: number; // for rectangle
  height?: number; // for rectangle
  radius?: number; // for circle
  angle?: number;
  isStatic: boolean;
  color?: string;
  friction?: number; // 0.0 (ice) to 1.0 (sandpaper)
}

export interface ConstraintDef {
  bodyAId: string;
  bodyBId?: string; // Added to support connecting two bodies
  pointB?: Point;
  stiffness?: number;
  length?: number;
}

export interface SceneConfig {
  bodies: BodyDef[];
  constraints: ConstraintDef[];
}

export interface PhysicsState {
  gravity: { x: number; y: number };
  timeScale: number;
  enableCollisionEffects: boolean;
}

export interface VoiceCommandResponse {
  summary?: string;
  physicsUpdates?: Partial<PhysicsState>;
  newBodies?: BodyDef[];
  updatedBodies?: BodyDef[]; // NEW: Supports resizing/modifying existing bodies
  newConstraints?: ConstraintDef[];
  removeBodyIds?: string[]; // IDs of bodies to delete
}

export enum AppMode {
  CAMERA = 'CAMERA',
  ANALYZING = 'ANALYZING',
  SIMULATION = 'SIMULATION',
}