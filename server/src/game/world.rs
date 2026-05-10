use super::protocol::{BoxSnapshot, PlayerSnapshot};
use super::room::PlayerInput;
use rapier3d::prelude::*;
use std::collections::HashMap;

const ARENA_HALF_SIZE: f32 = 12.0;
const WALL_HEIGHT: f32 = 1.1;
const WALL_THICKNESS: f32 = 0.24;
const PLAYER_RADIUS: f32 = 0.42;
const PLAYER_CENTER_Y: f32 = 0.34;
const PLAYER_MAX_SPEED: f32 = 10.0;
const PLAYER_ACCELERATION: f32 = 92.0;
const PLAYER_DECELERATION: f32 = 56.0;
const BOX_HALF_EXTENT: f32 = 0.45;
const BOX_DENSITY: f32 = 0.16;

pub struct World {
    pipeline: PhysicsPipeline,
    gravity: Vector,
    integration_parameters: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd_solver: CCDSolver,
    players: HashMap<u64, RigidBodyHandle>,
    boxes: Vec<BoxBody>,
}

#[derive(Clone, Copy, Debug)]
struct BoxBody {
    id: u64,
    body: RigidBodyHandle,
}

impl World {
    pub fn new() -> Self {
        let mut world = Self {
            pipeline: PhysicsPipeline::new(),
            gravity: Vector::new(0.0, -9.81, 0.0),
            integration_parameters: IntegrationParameters::default(),
            islands: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            players: HashMap::new(),
            boxes: Vec::new(),
        };

        world.build_static_arena();
        world.spawn_boxes();
        world
    }

    pub fn spawn_player(&mut self, player_id: u64) {
        if self.players.contains_key(&player_id) {
            return;
        }

        let spawn_index = (player_id - 1) as f32;
        let x = ((spawn_index % 5.0) - 2.0) * 1.2;
        let z = -3.2 + (spawn_index / 5.0).floor() * 1.2;
        let body = RigidBodyBuilder::dynamic()
            .translation(Vector::new(x, PLAYER_CENTER_Y, z))
            .lock_rotations()
            .linear_damping(2.5)
            .build();
        let body_handle = self.bodies.insert(body);
        let collider = ColliderBuilder::ball(PLAYER_RADIUS)
            .friction(1.0)
            .restitution(0.0)
            .build();
        self.colliders
            .insert_with_parent(collider, body_handle, &mut self.bodies);
        self.players.insert(player_id, body_handle);
    }

    pub fn despawn_player(&mut self, player_id: u64) {
        let Some(body_handle) = self.players.remove(&player_id) else {
            return;
        };

        self.bodies.remove(
            body_handle,
            &mut self.islands,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            true,
        );
    }

    pub fn apply_player_input(&mut self, player_id: u64, input: PlayerInput, delta_seconds: f32) {
        let Some(body_handle) = self.players.get(&player_id).copied() else {
            return;
        };
        let Some(body) = self.bodies.get_mut(body_handle) else {
            return;
        };

        let mut dx: f32 = 0.0;
        let mut dz: f32 = 0.0;

        if input.left {
            dx -= 1.0;
        }
        if input.right {
            dx += 1.0;
        }
        if input.up {
            dz -= 1.0;
        }
        if input.down {
            dz += 1.0;
        }

        let length = (dx * dx + dz * dz).sqrt();
        if length > 0.0 {
            dx /= length;
            dz /= length;
        }

        let target_x = dx * PLAYER_MAX_SPEED;
        let target_z = dz * PLAYER_MAX_SPEED;
        let acceleration = if length > 0.0 {
            PLAYER_ACCELERATION
        } else {
            PLAYER_DECELERATION
        };
        let max_delta = acceleration * delta_seconds;
        let velocity = body.linvel();
        body.set_linvel(
            Vector::new(
                move_toward(velocity.x, target_x, max_delta),
                velocity.y,
                move_toward(velocity.z, target_z, max_delta),
            ),
            true,
        );
    }

    pub fn step(&mut self, delta_seconds: f32) {
        self.integration_parameters.dt = delta_seconds;
        self.pipeline.step(
            self.gravity,
            &self.integration_parameters,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            &(),
            &(),
        );
    }

    pub fn player_snapshots(&self) -> Vec<PlayerSnapshot> {
        self.players
            .iter()
            .filter_map(|(&player_id, &body_handle)| {
                let body = self.bodies.get(body_handle)?;
                let position = body.translation();
                Some(PlayerSnapshot {
                    player_id,
                    x: position.x,
                    y: position.y,
                    z: position.z,
                })
            })
            .collect()
    }

    pub fn box_snapshots(&self) -> Vec<BoxSnapshot> {
        self.boxes
            .iter()
            .filter_map(|box_body| {
                let body = self.bodies.get(box_body.body)?;
                let position = body.translation();
                let rotation = body.rotation();
                Some(BoxSnapshot {
                    box_id: box_body.id,
                    x: position.x,
                    y: position.y,
                    z: position.z,
                    qx: rotation.x,
                    qy: rotation.y,
                    qz: rotation.z,
                    qw: rotation.w,
                })
            })
            .collect()
    }

    fn build_static_arena(&mut self) {
        self.add_fixed_cuboid(0.0, -0.12, 0.0, ARENA_HALF_SIZE, 0.12, ARENA_HALF_SIZE);
        self.add_fixed_cuboid(
            0.0,
            WALL_HEIGHT / 2.0,
            -ARENA_HALF_SIZE,
            ARENA_HALF_SIZE + WALL_THICKNESS,
            WALL_HEIGHT / 2.0,
            WALL_THICKNESS / 2.0,
        );
        self.add_fixed_cuboid(
            0.0,
            WALL_HEIGHT / 2.0,
            ARENA_HALF_SIZE,
            ARENA_HALF_SIZE + WALL_THICKNESS,
            WALL_HEIGHT / 2.0,
            WALL_THICKNESS / 2.0,
        );
        self.add_fixed_cuboid(
            -ARENA_HALF_SIZE,
            WALL_HEIGHT / 2.0,
            0.0,
            WALL_THICKNESS / 2.0,
            WALL_HEIGHT / 2.0,
            ARENA_HALF_SIZE + WALL_THICKNESS,
        );
        self.add_fixed_cuboid(
            ARENA_HALF_SIZE,
            WALL_HEIGHT / 2.0,
            0.0,
            WALL_THICKNESS / 2.0,
            WALL_HEIGHT / 2.0,
            ARENA_HALF_SIZE + WALL_THICKNESS,
        );
    }

    fn add_fixed_cuboid(&mut self, x: f32, y: f32, z: f32, hx: f32, hy: f32, hz: f32) {
        let collider = ColliderBuilder::cuboid(hx, hy, hz)
            .translation(Vector::new(x, y, z))
            .friction(1.0)
            .build();
        self.colliders.insert(collider);
    }

    fn spawn_boxes(&mut self) {
        let grid_size = 10;
        let spacing = 1.15;
        let start = -((grid_size - 1) as f32 * spacing) / 2.0;
        let center_z = 1.4;
        let mut id = 1;

        for row in 0..grid_size {
            for col in 0..grid_size {
                let x = start + col as f32 * spacing;
                let z = center_z + start + row as f32 * spacing;
                let body = RigidBodyBuilder::dynamic()
                    .translation(Vector::new(x, BOX_HALF_EXTENT, z))
                    .linear_damping(0.25)
                    .angular_damping(0.35)
                    .build();
                let body_handle = self.bodies.insert(body);
                let collider =
                    ColliderBuilder::cuboid(BOX_HALF_EXTENT, BOX_HALF_EXTENT, BOX_HALF_EXTENT)
                        .friction(0.55)
                        .restitution(0.05)
                        .density(BOX_DENSITY)
                        .build();
                self.colliders
                    .insert_with_parent(collider, body_handle, &mut self.bodies);
                self.boxes.push(BoxBody {
                    id,
                    body: body_handle,
                });
                id += 1;
            }
        }
    }
}

fn move_toward(current: f32, target: f32, max_delta: f32) -> f32 {
    let delta = target - current;
    if delta.abs() <= max_delta {
        target
    } else {
        current + delta.signum() * max_delta
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_input_moves_player_in_physics_world() {
        let mut world = World::new();
        world.spawn_player(1);
        let before = world.player_snapshots()[0].x;

        for _ in 0..20 {
            world.apply_player_input(
                1,
                PlayerInput {
                    right: true,
                    ..PlayerInput::default()
                },
                1.0 / 60.0,
            );
            world.step(1.0 / 60.0);
        }

        let after = world.player_snapshots()[0].x;
        assert!(after > before + 0.2);
    }

    #[test]
    fn player_input_accelerates_toward_target_speed() {
        let mut world = World::new();
        world.spawn_player(1);
        world.apply_player_input(
            1,
            PlayerInput {
                right: true,
                ..PlayerInput::default()
            },
            1.0 / 60.0,
        );
        let player_handle = world.players[&1];
        let player = world
            .bodies
            .get(player_handle)
            .expect("missing player body");

        assert!(player.linvel().x > 0.0);
        assert!(player.linvel().x < PLAYER_MAX_SPEED);
        assert!(player.linvel().z.abs() < 0.001);
    }

    #[test]
    fn player_without_input_decelerates_toward_zero() {
        let mut world = World::new();
        world.spawn_player(1);

        for _ in 0..20 {
            world.apply_player_input(
                1,
                PlayerInput {
                    right: true,
                    ..PlayerInput::default()
                },
                1.0 / 60.0,
            );
            world.step(1.0 / 60.0);
        }

        let player_handle = world.players[&1];
        let moving_speed = world
            .bodies
            .get(player_handle)
            .expect("missing player body")
            .linvel()
            .x;

        world.apply_player_input(1, PlayerInput::default(), 1.0 / 60.0);
        let decelerated_speed = world
            .bodies
            .get(player_handle)
            .expect("missing player body")
            .linvel()
            .x;

        assert!(decelerated_speed >= 0.0);
        assert!(decelerated_speed < moving_speed);
    }

    #[test]
    fn box_snapshots_include_initial_dynamic_boxes() {
        let world = World::new();
        let snapshots = world.box_snapshots();

        assert_eq!(snapshots.len(), 100);
        assert_eq!(snapshots[0].box_id, 1);
        assert_eq!(snapshots[99].box_id, 100);
    }
}
