use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tracing::{error, info};
use wtransport::{Connection, RecvStream, SendStream};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ConnectionId(pub u64);

#[derive(Debug)]
pub enum NetEvent {
    BidirectionalStream {
        connection_id: ConnectionId,
        stream: RawBidirectionalStream,
    },
    Datagram {
        connection_id: ConnectionId,
        payload: Vec<u8>,
    },
    Disconnected {
        connection_id: ConnectionId,
    },
}

pub type NetEventSender = mpsc::UnboundedSender<NetEvent>;
pub type NetEventReceiver = mpsc::UnboundedReceiver<NetEvent>;

#[derive(Debug)]
pub struct RawBidirectionalStream {
    pub send_stream: SendStream,
    pub recv_stream: RecvStream,
}

#[derive(Clone)]
pub struct ConnectionManager {
    next_connection_id: Arc<AtomicU64>,
    connections: Arc<Mutex<HashMap<ConnectionId, Connection>>>,
}

pub fn net_event_queue() -> (NetEventSender, NetEventReceiver) {
    mpsc::unbounded_channel()
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            next_connection_id: Arc::new(AtomicU64::new(1)),
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn handle_connection(
        &self,
        connection: Connection,
        event_sender: NetEventSender,
    ) -> Result<()> {
        let connection_id = ConnectionId(self.next_connection_id.fetch_add(1, Ordering::Relaxed));
        info!(connection_id = connection_id.0, remote = %connection.remote_address(), "transport client connected");
        self.insert_connection(connection_id, connection.clone());

        let datagram_connection: Connection = connection.clone();
        let datagram_events = event_sender.clone();
        tokio::spawn(async move {
            if let Err(error) =
                receive_datagrams(connection_id, datagram_connection, datagram_events).await
            {
                error!(
                    connection_id = connection_id.0,
                    ?error,
                    "datagram receive loop failed"
                );
            }
        });

        let result = self
            .accept_reliable_streams(connection_id, connection, event_sender.clone())
            .await;

        let _ = event_sender.send(NetEvent::Disconnected { connection_id });
        self.remove_connection(connection_id);

        result
    }

    pub fn send_datagram(&self, connection_id: ConnectionId, payload: &[u8]) -> Result<()> {
        let connection = self
            .connections
            .lock()
            .expect("connection registry mutex poisoned")
            .get(&connection_id)
            .cloned()
            .context("connection is not registered")?;

        connection
            .send_datagram(payload)
            .context("failed to send datagram")
    }

    pub fn max_datagram_size(&self, connection_id: ConnectionId) -> Option<usize> {
        self.connections
            .lock()
            .expect("connection registry mutex poisoned")
            .get(&connection_id)
            .and_then(Connection::max_datagram_size)
    }

    async fn accept_reliable_streams(
        &self,
        connection_id: ConnectionId,
        connection: Connection,
        event_sender: NetEventSender,
    ) -> Result<()> {
        loop {
            let (send_stream, recv_stream) = connection
                .accept_bi()
                .await
                .context("failed to accept bidirectional stream")?;

            let _ = event_sender.send(NetEvent::BidirectionalStream {
                connection_id,
                stream: RawBidirectionalStream {
                    send_stream,
                    recv_stream,
                },
            });
        }
    }

    fn insert_connection(&self, connection_id: ConnectionId, connection: Connection) {
        self.connections
            .lock()
            .expect("connection registry mutex poisoned")
            .insert(connection_id, connection);
    }

    fn remove_connection(&self, connection_id: ConnectionId) {
        self.connections
            .lock()
            .expect("connection registry mutex poisoned")
            .remove(&connection_id);
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

async fn receive_datagrams(
    connection_id: ConnectionId,
    connection: Connection,
    event_sender: NetEventSender,
) -> Result<()> {
    loop {
        let datagram = connection
            .receive_datagram()
            .await
            .context("failed to receive datagram")?;
        let _ = event_sender.send(NetEvent::Datagram {
            connection_id,
            payload: datagram.payload().to_vec(),
        });
    }
}
