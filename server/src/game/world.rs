use super::protocol::{BoxSnapshot, PlayerSnapshot};
use super::room::PlayerInput;
use crate::config::GameConfig;
use rapier3d::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

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
    config: Arc<GameConfig>,
}

#[derive(Clone, Copy, Debug)]
struct BoxBody {
    id: u64,
    body: RigidBodyHandle,
}

impl World {
    pub fn new(config: Arc<GameConfig>) -> Self {
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
            config,
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
            .translation(Vector::new(x, self.config.player.center_y, z))
            .linear_damping(self.config.player.linear_damping)
            .angular_damping(self.config.player.angular_damping)
            .build();
        let body_handle = self.bodies.insert(body);
        let collider = ColliderBuilder::ball(self.config.player.radius)
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

        let has_input = length > 0.0;
        if has_input {
            let desired_direction = Vector::new(dx, 0.0, dz);
            let torque = Vector::Y.cross(desired_direction) * self.config.player.move_torque;
            body.add_torque(torque, true);
        }

        let velocity = body.linvel();
        let angular_velocity = body.angvel();
        let horizontal_velocity = Vector::new(velocity.x, 0.0, velocity.z);
        let horizontal_angular_velocity = Vector::new(angular_velocity.x, 0.0, angular_velocity.z);
        let rolling_velocity =
            horizontal_angular_velocity.cross(Vector::Y) * self.config.player.radius;
        let horizontal_speed = horizontal_velocity.length();
        let rolling_speed = rolling_velocity.length();

        let horizontal_angular_speed = horizontal_angular_velocity.length();
        let stuck_spinning =
            horizontal_speed < 0.25 && rolling_speed > self.config.player.slip_brake_speed;
        if (!has_input && horizontal_angular_speed > 0.15) || (has_input && stuck_spinning) {
            let brake_torque = angular_brake_torque(
                horizontal_angular_velocity,
                self.config.player.spin_brake_torque,
                body.mass(),
                self.config.player.radius,
                delta_seconds,
            );
            body.add_torque(brake_torque, true);
        }
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
                let rotation = body.rotation();
                let velocity = body.linvel();
                let angular_velocity = body.angvel();
                Some(PlayerSnapshot {
                    player_id,
                    x: position.x,
                    y: position.y,
                    z: position.z,
                    qx: rotation.x,
                    qy: rotation.y,
                    qz: rotation.z,
                    qw: rotation.w,
                    vx: velocity.x,
                    vy: velocity.y,
                    vz: velocity.z,
                    wx: angular_velocity.x,
                    wy: angular_velocity.y,
                    wz: angular_velocity.z,
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
                let velocity = body.linvel();
                let angular_velocity = body.angvel();
                Some(BoxSnapshot {
                    box_id: box_body.id,
                    x: position.x,
                    y: position.y,
                    z: position.z,
                    qx: rotation.x,
                    qy: rotation.y,
                    qz: rotation.z,
                    qw: rotation.w,
                    vx: velocity.x,
                    vy: velocity.y,
                    vz: velocity.z,
                    wx: angular_velocity.x,
                    wy: angular_velocity.y,
                    wz: angular_velocity.z,
                })
            })
            .collect()
    }

    fn build_static_arena(&mut self) {
        let arena_half_size = self.config.arena.half_size;
        let wall_height = self.config.arena.wall_height;
        let wall_thickness = self.config.arena.wall_thickness;
        let floor_half_thickness = self.config.arena.floor_thickness / 2.0;

        self.add_fixed_cuboid(
            0.0,
            -floor_half_thickness,
            0.0,
            arena_half_size,
            floor_half_thickness,
            arena_half_size,
        );
        self.add_fixed_cuboid(
            0.0,
            wall_height / 2.0,
            -arena_half_size,
            arena_half_size + wall_thickness,
            wall_height / 2.0,
            wall_thickness / 2.0,
        );
        self.add_fixed_cuboid(
            0.0,
            wall_height / 2.0,
            arena_half_size,
            arena_half_size + wall_thickness,
            wall_height / 2.0,
            wall_thickness / 2.0,
        );
        self.add_fixed_cuboid(
            -arena_half_size,
            wall_height / 2.0,
            0.0,
            wall_thickness / 2.0,
            wall_height / 2.0,
            arena_half_size + wall_thickness,
        );
        self.add_fixed_cuboid(
            arena_half_size,
            wall_height / 2.0,
            0.0,
            wall_thickness / 2.0,
            wall_height / 2.0,
            arena_half_size + wall_thickness,
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
        let grid_columns = self.config.boxes.grid_columns;
        let grid_rows = self.config.boxes.grid_rows;
        let spacing = self.config.boxes.spacing;
        let start_x = -((grid_columns - 1) as f32 * spacing) / 2.0;
        let start_z = -((grid_rows - 1) as f32 * spacing) / 2.0;
        let center_z = self.config.boxes.center_z;
        let half_extent = self.config.boxes.half_extent;
        let density = self.config.boxes.density;
        let mut id = 1;

        for row in 0..grid_rows {
            for col in 0..grid_columns {
                let x = start_x + col as f32 * spacing;
                let z = center_z + start_z + row as f32 * spacing;
                let body = RigidBodyBuilder::dynamic()
                    .translation(Vector::new(x, half_extent, z))
                    .linear_damping(0.25)
                    .angular_damping(0.35)
                    .build();
                let body_handle = self.bodies.insert(body);
                let collider = ColliderBuilder::cuboid(half_extent, half_extent, half_extent)
                    .friction(0.55)
                    .restitution(0.05)
                    .density(density)
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

fn angular_brake_torque(
    horizontal_angular_velocity: Vector,
    max_torque: f32,
    mass: f32,
    radius: f32,
    delta_seconds: f32,
) -> Vector {
    let angular_speed = horizontal_angular_velocity.length();
    if angular_speed <= 0.15 || delta_seconds <= 0.0 || mass <= 0.0 || radius <= 0.0 {
        return Vector::ZERO;
    }

    let inertia = 0.4 * mass * radius * radius;
    let torque_to_stop = (angular_speed * inertia) / delta_seconds;
    -horizontal_angular_velocity.normalize() * max_torque.min(torque_to_stop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_game_config;

    fn test_config() -> Arc<GameConfig> {
        Arc::new(load_game_config().unwrap())
    }

    #[test]
    fn player_input_moves_player_in_physics_world() {
        let mut world = World::new(test_config());
        world.spawn_player(1);
        let before = world.player_snapshots()[0].x;

        for _ in 0..120 {
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
        assert!(after > before + 0.8);
    }

    #[test]
    fn player_input_applies_torque_to_player_body() {
        let mut world = World::new(test_config());
        world.spawn_player(1);
        world.apply_player_input(
            1,
            PlayerInput {
                right: true,
                ..PlayerInput::default()
            },
            1.0 / 60.0,
        );
        world.step(1.0 / 60.0);
        let player_handle = world.players[&1];
        let player = world
            .bodies
            .get(player_handle)
            .expect("missing player body");

        assert!(player.linvel().x > 0.0);
        assert!(player.linvel().z.abs() < 0.001);
        assert!(player.angvel().z < -0.001);
    }

    #[test]
    fn player_without_input_naturally_slows_down() {
        let mut world = World::new(test_config());
        world.spawn_player(1);

        for _ in 0..120 {
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
            .length();

        for _ in 0..240 {
            world.apply_player_input(1, PlayerInput::default(), 1.0 / 60.0);
            world.step(1.0 / 60.0);
        }
        let decelerated_speed = world
            .bodies
            .get(player_handle)
            .expect("missing player body")
            .linvel()
            .length();

        assert!(decelerated_speed >= 0.0);
        assert!(decelerated_speed < moving_speed);
    }

    #[test]
    fn player_ball_rolls_when_moving() {
        let mut world = World::new(test_config());
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

        let snapshot = world.player_snapshots()[0].clone();
        assert!(snapshot.wx.abs() > 0.001 || snapshot.wz.abs() > 0.001);
        assert!(
            snapshot.qx.abs() > 0.001 || snapshot.qy.abs() > 0.001 || snapshot.qz.abs() > 0.001
        );
    }

    #[test]
    fn box_snapshots_include_initial_dynamic_boxes() {
        let world = World::new(test_config());
        let snapshots = world.box_snapshots();
        let expected_box_count = world.config.boxes.grid_columns * world.config.boxes.grid_rows;

        assert_eq!(snapshots.len(), expected_box_count as usize);
        assert_eq!(snapshots[0].box_id, 1);
        assert_eq!(
            snapshots.last().expect("missing final box").box_id,
            expected_box_count as u64
        );
    }
}
