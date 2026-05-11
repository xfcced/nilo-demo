use anyhow::{Context, Result};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};
use wtransport::endpoint::IncomingSession;
use wtransport::{Connection, Endpoint, Identity, ServerConfig};

pub struct WebTransportListener {
    endpoint: Endpoint<wtransport::endpoint::endpoint_side::Server>,
    path: Arc<str>,
}

impl WebTransportListener {
    pub fn new(port: u16, identity: Identity, path: impl Into<Arc<str>>) -> Result<Self> {
        let config = ServerConfig::builder()
            .with_bind_default(port)
            .with_identity(identity)
            .keep_alive_interval(Some(Duration::from_secs(3)))
            .build();

        let endpoint =
            Endpoint::server(config).context("failed to create WebTransport endpoint")?;

        Ok(Self {
            endpoint,
            path: path.into(),
        })
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        self.endpoint
            .local_addr()
            .context("failed to read server local address")
    }

    pub async fn serve<F, Fut>(self, handler: F) -> Result<()>
    where
        F: Fn(Connection) -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let local_addr = self.local_addr()?;
        info!(
            "WebTransport server listening on https://localhost:{}{}",
            local_addr.port(),
            self.path
        );

        loop {
            let incoming_session = self.endpoint.accept().await;
            let path = Arc::clone(&self.path);
            let handler = handler.clone();

            tokio::spawn(async move {
                if let Err(error) = handle_incoming_session(incoming_session, path, handler).await {
                    error!(?error, "WebTransport session failed");
                }
            });
        }
    }
}

async fn handle_incoming_session<F, Fut>(
    incoming_session: IncomingSession,
    path: Arc<str>,
    handler: F,
) -> Result<()>
where
    F: Fn(Connection) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    let request = incoming_session
        .await
        .context("failed to receive session request")?;

    if request.path() != path.as_ref() {
        warn!(path = request.path(), "rejecting unknown WebTransport path");
        request.not_found().await;
        return Ok(());
    }

    let connection = request.accept().await.context("failed to accept session")?;
    info!(remote = %connection.remote_address(), "client connected");

    handler(connection).await
}
