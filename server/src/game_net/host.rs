use super::binary::{decode_input, encode_state, BinaryState};
use super::framing::{
    outbound_frame_queue, write_framed_messages, FramedStreamReader, OutboundFrameSender,
};
use crate::config::ProtocolConfig;
use crate::game::protocol::{ClientMessage, ServerMessage};
use crate::game::room::RoomSnapshot;
use crate::net::{
    net_event_queue, ConnectionId, ConnectionManager, NetEvent, NetEventReceiver,
    RawBidirectionalStream, WebTransportListener,
};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use wtransport::Identity;

const CONTROL_CHANNEL: &str = "control";
const PROBE_CHANNEL: &str = "probe";

#[derive(Debug)]
pub enum GameNetEvent {
    Message {
        connection_id: ConnectionId,
        message: ClientMessage,
    },
    Disconnected {
        connection_id: ConnectionId,
    },
}

pub type GameNetEventSender = mpsc::UnboundedSender<GameNetEvent>;
pub type GameNetEventReceiver = mpsc::UnboundedReceiver<GameNetEvent>;

#[derive(Clone)]
pub struct GameNetworkHost {
    listener: Arc<Mutex<Option<WebTransportListener>>>,
    connections: ConnectionManager,
    reliable_channels: Arc<Mutex<HashMap<ChannelKey, OutboundFrameSender>>>,
    protocol: Arc<ProtocolConfig>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ChannelKey {
    connection_id: ConnectionId,
    channel: String,
}

pub fn game_net_event_queue() -> (GameNetEventSender, GameNetEventReceiver) {
    mpsc::unbounded_channel()
}

impl GameNetworkHost {
    pub fn event_queue() -> (GameNetEventSender, GameNetEventReceiver) {
        game_net_event_queue()
    }

    pub fn new(
        port: u16,
        identity: Identity,
        path: &str,
        protocol: Arc<ProtocolConfig>,
    ) -> Result<Self> {
        let listener = WebTransportListener::new(port, identity, path)?;
        Ok(Self {
            listener: Arc::new(Mutex::new(Some(listener))),
            connections: ConnectionManager::new(),
            reliable_channels: Arc::new(Mutex::new(HashMap::new())),
            protocol,
        })
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        self.listener
            .lock()
            .expect("game network listener mutex poisoned")
            .as_ref()
            .context("game network listener already started")?
            .local_addr()
    }

    pub async fn serve(self, event_sender: GameNetEventSender) -> Result<()> {
        let (raw_event_sender, raw_event_receiver) = net_event_queue();

        let raw_events_host = self.clone();
        tokio::spawn(async move {
            handle_raw_net_events(raw_event_receiver, raw_events_host, event_sender).await;
        });

        let listener = self
            .listener
            .lock()
            .expect("game network listener mutex poisoned")
            .take()
            .context("game network listener already started")?;

        let connections = self.connections.clone();
        listener
            .serve(move |connection| {
                let connections = connections.clone();
                let raw_event_sender = raw_event_sender.clone();
                async move {
                    connections
                        .handle_connection(connection, raw_event_sender)
                        .await
                }
            })
            .await
    }

    pub fn send_message(&self, connection_id: ConnectionId, message: ServerMessage) -> Result<()> {
        let payload = serde_json::to_vec(&message).context("failed to encode server message")?;
        self.send_reliable(connection_id, CONTROL_CHANNEL, payload)
    }

    pub fn send_state(&self, connection_id: ConnectionId, snapshot: &RoomSnapshot) -> Result<()> {
        let payload = encode_state(BinaryState {
            server_tick: snapshot.server_tick,
            last_processed_input_seq: snapshot.last_processed_input_seq,
            players: &snapshot.players,
            boxes: &snapshot.boxes,
            position_scale: self.protocol.position_scale,
            quaternion_scale: self.protocol.quaternion_scale,
        })
        .context("failed to encode state datagram")?;

        if let Some(max_size) = self.connections.max_datagram_size(connection_id) {
            if payload.len() > max_size {
                warn!(
                    connection_id = connection_id.0,
                    bytes = payload.len(),
                    max_size,
                    "state datagram exceeds current transport max size"
                );
            }
        }

        self.connections.send_datagram(connection_id, &payload)
    }

    fn send_reliable(
        &self,
        connection_id: ConnectionId,
        channel: &str,
        payload: Vec<u8>,
    ) -> Result<()> {
        let key = ChannelKey {
            connection_id,
            channel: channel.to_string(),
        };
        let sender = self
            .reliable_channels
            .lock()
            .expect("reliable channel registry mutex poisoned")
            .get(&key)
            .cloned();

        if let Some(sender) = sender {
            sender
                .send(payload)
                .context("failed to queue reliable message")?;
        }

        Ok(())
    }

    fn insert_channel(
        &self,
        connection_id: ConnectionId,
        channel: String,
        sender: OutboundFrameSender,
    ) {
        self.reliable_channels
            .lock()
            .expect("reliable channel registry mutex poisoned")
            .insert(
                ChannelKey {
                    connection_id,
                    channel,
                },
                sender,
            );
    }

    fn remove_channel(&self, connection_id: ConnectionId, channel: &str) {
        self.reliable_channels
            .lock()
            .expect("reliable channel registry mutex poisoned")
            .remove(&ChannelKey {
                connection_id,
                channel: channel.to_string(),
            });
    }

    fn remove_client(&self, connection_id: ConnectionId) {
        self.reliable_channels
            .lock()
            .expect("reliable channel registry mutex poisoned")
            .retain(|key, _| key.connection_id != connection_id);
    }
}

async fn handle_raw_net_events(
    mut raw_event_receiver: NetEventReceiver,
    network: GameNetworkHost,
    game_event_sender: GameNetEventSender,
) {
    while let Some(event) = raw_event_receiver.recv().await {
        match event {
            NetEvent::BidirectionalStream {
                connection_id,
                stream,
            } => {
                let stream_network = network.clone();
                let stream_events = game_event_sender.clone();
                tokio::spawn(async move {
                    if let Err(error) =
                        handle_reliable_stream(connection_id, stream, stream_network, stream_events)
                            .await
                    {
                        error!(
                            connection_id = connection_id.0,
                            ?error,
                            "reliable stream failed"
                        );
                    }
                });
            }
            NetEvent::Datagram {
                connection_id,
                payload,
            } => {
                handle_datagram_payload(connection_id, payload, &game_event_sender);
            }
            NetEvent::Disconnected { connection_id } => {
                network.remove_client(connection_id);
                let _ = game_event_sender.send(GameNetEvent::Disconnected { connection_id });
            }
        }
    }
}

fn handle_datagram_payload(
    connection_id: ConnectionId,
    payload: Vec<u8>,
    event_sender: &GameNetEventSender,
) {
    match decode_input(&payload) {
        Ok(input) => {
            let _ = event_sender.send(GameNetEvent::Message {
                connection_id,
                message: ClientMessage::Input {
                    seq: input.seq as u64,
                    up: input.input.up,
                    down: input.input.down,
                    left: input.input.left,
                    right: input.input.right,
                },
            });
        }
        Err(error) => {
            warn!(
                connection_id = connection_id.0,
                bytes = payload.len(),
                ?error,
                "ignoring invalid datagram payload"
            );
        }
    }
}

async fn handle_reliable_stream(
    connection_id: ConnectionId,
    stream: RawBidirectionalStream,
    network: GameNetworkHost,
    event_sender: GameNetEventSender,
) -> Result<()> {
    let RawBidirectionalStream {
        send_stream,
        recv_stream,
    } = stream;

    let mut reader = FramedStreamReader::new(recv_stream);
    let Some(channel_payload) = reader.read_frame().await? else {
        return Ok(());
    };
    let channel = String::from_utf8(channel_payload).context("invalid channel name")?;

    let (frame_sender, frame_receiver) = outbound_frame_queue();
    network.insert_channel(connection_id, channel.clone(), frame_sender);

    let writer_channel = channel.clone();
    tokio::spawn(async move {
        if let Err(error) = write_framed_messages(send_stream, frame_receiver).await {
            error!(
                connection_id = connection_id.0,
                channel = writer_channel,
                ?error,
                "frame write stream failed"
            );
        }
    });

    while let Some(payload) = reader.read_frame().await? {
        handle_reliable_payload(connection_id, &channel, payload, &network, &event_sender);
    }

    network.remove_channel(connection_id, &channel);
    Ok(())
}

fn handle_reliable_payload(
    connection_id: ConnectionId,
    channel: &str,
    payload: Vec<u8>,
    network: &GameNetworkHost,
    event_sender: &GameNetEventSender,
) {
    match channel {
        CONTROL_CHANNEL => handle_control_payload(connection_id, payload, network, event_sender),
        PROBE_CHANNEL => {
            info!(
                connection_id = connection_id.0,
                channel,
                bytes = payload.len(),
                payload = %String::from_utf8_lossy(&payload),
                "received reliable probe frame"
            );
        }
        _ => {
            warn!(
                connection_id = connection_id.0,
                channel, "ignoring unknown reliable channel"
            );
        }
    }
}

fn handle_control_payload(
    connection_id: ConnectionId,
    payload: Vec<u8>,
    network: &GameNetworkHost,
    event_sender: &GameNetEventSender,
) {
    let raw = String::from_utf8_lossy(&payload).trim().to_owned();
    if raw.is_empty() {
        return;
    }

    match serde_json::from_str::<ClientMessage>(&raw) {
        Ok(message) => {
            let _ = event_sender.send(GameNetEvent::Message {
                connection_id,
                message,
            });
        }
        Err(error) => {
            let result = network.send_message(
                connection_id,
                ServerMessage::Error {
                    message: format!("invalid message: {error}"),
                },
            );
            if let Err(error) = result {
                error!(
                    connection_id = connection_id.0,
                    ?error,
                    "failed to send invalid message response"
                );
            }
        }
    }
}
