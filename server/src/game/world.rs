use super::protocol::{BoxSnapshot, PlayerSnapshot};
use super::room::PlayerInput;
use crate::config::{BoxesConfig, GameConfig, SlopeConfig};
use glam::{EulerRot, Quat};
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
    pending_box_launch: bool,
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
            pending_box_launch: true,
            config,
        };

        world.build_slope_scene();
        world.spawn_boxes();
        world
    }

    pub fn spawn_player(&mut self, player_id: u64) {
        if self.players.contains_key(&player_id) {
            return;
        }

        let spawn_index = (player_id - 1) as f32;
        let x = self.config.player.spawn_x
            + ((spawn_index % 5.0) - 2.0) * self.config.player.spawn_spread_x;
        let body = RigidBodyBuilder::dynamic()
            .translation(Vector::new(
                x,
                self.config.player.spawn_y,
                self.config.player.spawn_z,
            ))
            .lock_rotations()
            .linear_damping(2.5)
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
            dx += 1.0;
        }
        if input.right {
            dx -= 1.0;
        }
        // Up climbs toward +Z (top of slope); down moves toward recycle zone.
        if input.up {
            dz += 1.0;
        }
        if input.down {
            dz -= 1.0;
        }

        let length = (dx * dx + dz * dz).sqrt();
        if length > 0.0 {
            dx /= length;
            dz /= length;
        }

        let target_x = dx * self.config.player.max_speed;
        let target_z = dz * self.config.player.max_speed;
        let acceleration = if length > 0.0 {
            self.config.player.acceleration
        } else {
            self.config.player.deceleration
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
        if self.pending_box_launch {
            let handles = self.boxes.iter().map(|box_body| box_body.body).collect::<Vec<_>>();
            let impulse = self.config.boxes.spawn_launch_impulse;
            let min_speed = self.config.boxes.launch_min_speed;
            for body_handle in handles {
                self.launch_box_along_slope(body_handle, impulse, min_speed);
            }
            self.pending_box_launch = false;
        }

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
        self.recycle_boxes();
    }

    pub fn player_snapshots(&self) -> Vec<PlayerSnapshot> {
        self.players
            .iter()
            .filter_map(|(&player_id, &body_handle)| {
                let body = self.bodies.get(body_handle)?;
                let position = body.translation();
                let velocity = body.linvel();
                Some(PlayerSnapshot {
                    player_id,
                    x: position.x,
                    y: position.y,
                    z: position.z,
                    vx: velocity.x,
                    vy: velocity.y,
                    vz: velocity.z,
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

    fn build_slope_scene(&mut self) {
        let slope = self.config.slope.clone();
        let collider = ColliderBuilder::cuboid(slope.half_x, slope.half_y, slope.half_z)
            .translation(Vector::new(
                slope.center_x,
                slope.center_y,
                slope.center_z,
            ))
            .rotation(Vector::new(
                slope.rotation_x,
                slope.rotation_y,
                slope.rotation_z,
            ))
            .friction(slope.friction)
            .build();
        self.colliders.insert(collider);

        let rotation = Vector::new(
            slope.rotation_x,
            slope.rotation_y,
            slope.rotation_z,
        );
        let wall_half_height = slope.side_wall_height / 2.0;
        let wall_half_thickness = slope.side_wall_thickness / 2.0;
        let wall_half_depth = slope.half_z + 0.2;

        for side_sign in [-1.0_f32, 1.0] {
            let translation = side_wall_translation(&slope, side_sign);
            let collider = ColliderBuilder::cuboid(
                wall_half_thickness,
                wall_half_height,
                wall_half_depth,
            )
            .translation(translation)
            .rotation(rotation)
            .friction(1.0)
            .build();
            self.colliders.insert(collider);
        }
    }

    fn spawn_boxes(&mut self) {
        let half_extent = self.config.boxes.half_extent;
        let density = self.config.boxes.density;

        let linear_damping = self.config.boxes.linear_damping;
        let angular_damping = self.config.boxes.angular_damping;
        let friction = self.config.boxes.friction;

        for index in 0..self.config.boxes.count {
            let box_id = index as u64 + 1;
            let (x, y, z) = self.box_launch_position(index as usize);
            let body = RigidBodyBuilder::dynamic()
                .translation(Vector::new(x, y, z))
                .linear_damping(linear_damping)
                .angular_damping(angular_damping)
                .ccd_enabled(true)
                .build();
            let body_handle = self.bodies.insert(body);
            if let Some(body) = self.bodies.get_mut(body_handle) {
                body.set_rotation(
                    random_box_rotation(&self.config.slope, &self.config.boxes, box_id),
                    true,
                );
            }
            let collider = ColliderBuilder::cuboid(half_extent, half_extent, half_extent)
                .friction(friction)
                .restitution(0.02)
                .density(density)
                .build();
            self.colliders
                .insert_with_parent(collider, body_handle, &mut self.bodies);
            self.boxes.push(BoxBody {
                id: box_id,
                body: body_handle,
            });
        }
    }

    fn recycle_boxes(&mut self) {
        let recycle_z = self.config.slope.recycle_z;
        let box_count = self.boxes.len();
        for index in 0..box_count {
            let box_body = self.boxes[index];
            let body_handle = box_body.body;
            let Some(body) = self.bodies.get(body_handle) else {
                continue;
            };

            if body.translation().z > recycle_z {
                continue;
            }

            let (x, y, z) = self.box_launch_position(index);
            let Some(body) = self.bodies.get_mut(body_handle) else {
                continue;
            };

            let box_id = box_body.id;
            body.set_translation(Vector::new(x, y, z), true);
            body.set_rotation(
                random_box_rotation(&self.config.slope, &self.config.boxes, box_id),
                true,
            );
            body.set_linvel(Vector::ZERO, true);
            body.set_angvel(Vector::ZERO, true);
            self.launch_box_along_slope(
                body_handle,
                self.config.boxes.recycle_launch_impulse,
                self.config.boxes.launch_min_speed,
            );
        }
    }

    fn box_launch_position(&self, index: usize) -> (f32, f32, f32) {
        let columns = self.config.boxes.columns.max(1) as usize;
        let col = index % columns;
        let row = index / columns;
        let start_x = -((columns as f32 - 1.0) * self.config.boxes.spacing) / 2.0;
        let local_x = start_x + col as f32 * self.config.boxes.spacing;
        let local_z =
            self.config.slope.half_z - self.config.slope.launch_local_z_inset
                - row as f32 * self.config.boxes.row_spacing;
        let clearance = self.config.boxes.half_extent + self.config.boxes.surface_clearance;
        let world = slope_surface_world_position(&self.config.slope, local_x, local_z, clearance);
        (world.x, world.y, world.z)
    }

    fn box_mass(&self) -> f32 {
        let half_extent = self.config.boxes.half_extent;
        let side = half_extent * 2.0;
        self.config.boxes.density * side * side * side
    }

    fn launch_box_along_slope(
        &mut self,
        body_handle: RigidBodyHandle,
        impulse: f32,
        min_speed: f32,
    ) {
        let downhill = slope_downhill_direction(&self.config.slope);
        let mass = self.box_mass().max(f32::EPSILON);
        let speed_from_impulse = if impulse > 0.0 {
            impulse / mass
        } else {
            0.0
        };
        let launch_speed = speed_from_impulse.max(min_speed);

        let Some(body) = self.bodies.get_mut(body_handle) else {
            return;
        };

        body.set_linvel(downhill * launch_speed, true);
        if impulse > 0.0 {
            body.apply_impulse(downhill * impulse, true);
        }
        body.wake_up(true);
    }
}

fn random_box_rotation(slope: &SlopeConfig, boxes: &BoxesConfig, box_id: u64) -> Rotation {
    let yaw = pseudo_random01(box_id, 1) * boxes.spawn_rotation_max_yaw;
    let tilt_x = (pseudo_random01(box_id, 2) * 2.0 - 1.0) * boxes.spawn_rotation_max_tilt;
    let tilt_z = (pseudo_random01(box_id, 3) * 2.0 - 1.0) * boxes.spawn_rotation_max_tilt;
    let local = Quat::from_euler(EulerRot::XYZ, tilt_x, yaw, tilt_z);
    let slope_rot = Quat::from_euler(
        EulerRot::XYZ,
        slope.rotation_x,
        slope.rotation_y,
        slope.rotation_z,
    );
    local * slope_rot
}

fn pseudo_random01(seed: u64, channel: u64) -> f32 {
    let mut hash = seed.wrapping_mul(6364136223846793005).wrapping_add(channel);
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(0xff51afd7ed558ccd);
    hash ^= hash >> 33;
    let unit = (hash & 0x00ff_ffff) as f32 / 16_777_215.0;
    unit.clamp(0.0, 1.0)
}

fn slope_downhill_direction(slope: &SlopeConfig) -> Vector {
    let direction = rotate_vector_by_slope_euler(slope, Vector::new(0.0, 0.0, -1.0));
    if direction.length_squared() <= f32::EPSILON {
        return Vector::new(0.0, 0.0, -1.0);
    }

    direction.normalize()
}

fn side_wall_translation(slope: &SlopeConfig, side_sign: f32) -> Vector {
    let wall_half_thickness = slope.side_wall_thickness / 2.0;
    let local_offset = Vector::new(
        side_sign * (slope.half_x + wall_half_thickness),
        0.0,
        0.0,
    );
    rotate_vector_by_slope_euler(slope, local_offset)
        + Vector::new(slope.center_x, slope.center_y, slope.center_z)
}

pub(crate) fn slope_surface_world_position(
    slope: &SlopeConfig,
    local_x: f32,
    local_z: f32,
    clearance_above_surface: f32,
) -> Vector {
    let local_point = Vector::new(
        local_x,
        slope.half_y + clearance_above_surface,
        local_z,
    );
    rotate_vector_by_slope_euler(slope, local_point)
        + Vector::new(slope.center_x, slope.center_y, slope.center_z)
}

fn rotate_vector_by_slope_euler(slope: &SlopeConfig, local: Vector) -> Vector {
    let (rx, ry, rz) = (
        slope.rotation_x,
        slope.rotation_y,
        slope.rotation_z,
    );
    let (sx, cx) = rx.sin_cos();
    let (sy, cy) = ry.sin_cos();
    let (sz, cz) = rz.sin_cos();

    let y1 = cx * local.y - sx * local.z;
    let z1 = sx * local.y + cx * local.z;
    let after_x = Vector::new(local.x, y1, z1);

    let x2 = cy * after_x.x + sy * after_x.z;
    let z2 = -sy * after_x.x + cy * after_x.z;
    let after_y = Vector::new(x2, after_x.y, z2);

    let x3 = cz * after_y.x - sz * after_y.y;
    let y3 = sz * after_y.x + cz * after_y.y;
    Vector::new(x3, y3, after_y.z)
}

fn move_toward(current: f32, target: f32, max_delta: f32) -> f32 {
    let delta = target - current;
    if delta.abs() <= max_delta {
        return target;
    }

    current + delta.signum() * max_delta
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
        let before = world.player_snapshots()[0].z;

        for _ in 0..120 {
            world.apply_player_input(
                1,
                PlayerInput {
                    up: true,
                    ..PlayerInput::default()
                },
                1.0 / 60.0,
            );
            world.step(1.0 / 60.0);
        }

        let after = world.player_snapshots()[0].z;
        assert!(after > before + 0.2);
    }

    #[test]
    fn player_input_accelerates_toward_target_speed() {
        let mut world = World::new(test_config());
        world.spawn_player(1);
        world.apply_player_input(
            1,
            PlayerInput {
                left: true,
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
        assert!(player.linvel().x < world.config.player.max_speed);
        assert!(player.linvel().z.abs() < 0.001);
    }

    #[test]
    fn player_without_input_decelerates_toward_zero() {
        let mut world = World::new(test_config());
        world.spawn_player(1);

        for _ in 0..20 {
            world.apply_player_input(
                1,
                PlayerInput {
                    left: true,
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
    fn box_spawn_launches_downhill_after_step() {
        let mut world = World::new(test_config());
        world.step(1.0 / 30.0);

        let box_handle = world
            .box_handle_for_id(1)
            .expect("missing box");
        let velocity = world
            .bodies
            .get(box_handle)
            .expect("missing box body")
            .linvel();
        let downhill = slope_downhill_direction(&world.config.slope);
        let downhill_speed =
            velocity.x * downhill.x + velocity.y * downhill.y + velocity.z * downhill.z;

        assert!(
            downhill_speed > 0.05,
            "expected downhill motion, got projected speed {downhill_speed}"
        );
    }

    #[test]
    fn box_spawn_assigns_distinct_rotations() {
        let world = World::new(test_config());
        let first = world
            .bodies
            .get(world.box_handle_for_id(1).expect("missing box"))
            .expect("missing box body")
            .rotation();
        let second = world
            .bodies
            .get(world.box_handle_for_id(2).expect("missing box"))
            .expect("missing box body")
            .rotation();

        let first_identity = first.w.abs() > 0.999 && first.x.abs() < 0.01 && first.y.abs() < 0.01;
        let differs = (first.x - second.x).abs() > 0.01
            || (first.y - second.y).abs() > 0.01
            || (first.z - second.z).abs() > 0.01
            || (first.w - second.w).abs() > 0.01;

        assert!(!first_identity || differs);
        assert!(differs);
    }

    #[test]
    fn box_recycles_when_it_reaches_bottom() {
        let mut world = World::new(test_config());
        let box_handle = world
            .box_handle_for_id(1)
            .expect("missing box");

        world
            .bodies
            .get_mut(box_handle)
            .expect("missing box body")
            .set_translation(
                Vector::new(0.0, world.config.player.spawn_y, world.config.slope.recycle_z - 1.0),
                true,
            );

        world.recycle_boxes();

        let recycled = world
            .bodies
            .get(box_handle)
            .expect("missing box body")
            .translation();
        assert!(recycled.z > world.config.slope.recycle_z + 5.0);
    }

    #[test]
    fn box_snapshots_include_initial_dynamic_boxes() {
        let world = World::new(test_config());
        let snapshots = world.box_snapshots();
        let expected_box_count = world.config.boxes.count;

        assert_eq!(snapshots.len(), expected_box_count as usize);
        assert_eq!(snapshots[0].box_id, 1);
        assert_eq!(
            snapshots.last().expect("missing final box").box_id,
            expected_box_count as u64
        );
    }

    impl World {
        fn box_handle_for_id(&self, box_id: u64) -> Option<RigidBodyHandle> {
            self.boxes
                .iter()
                .find(|box_body| box_body.id == box_id)
                .map(|box_body| box_body.body)
        }
    }
}
