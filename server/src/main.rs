mod protocol;
mod room;
mod transport;

use anyhow::{Context, Result};
use room::Room;
use std::sync::Arc;
use transport::WebTransportServer;
use tracing::info;
use wtransport::tls::Sha256DigestFmt;
use wtransport::Identity;

const PORT: u16 = 4433;
const CERT_FILE: &str = "certs/localhost.pem";
const KEY_FILE: &str = "certs/localhost-key.pem";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nilo_demo_server=info,info".into()),
        )
        .init();

    let identity = load_or_create_identity().await?;
    print_certificate_hash(&identity);

    let room = Arc::new(Room::new());
    let server = WebTransportServer::new(PORT, identity, room)?;
    let addr = server.local_addr()?;

    info!("server ready");
    println!("WebTransport URL: https://localhost:{}{}", addr.port(), "/webtransport");

    server.serve().await
}

async fn load_or_create_identity() -> Result<Identity> {
    match Identity::load_pemfiles(CERT_FILE, KEY_FILE).await {
        Ok(identity) => Ok(identity),
        Err(error) => {
            eprintln!("Could not load existing certificate files: {error}");
            eprintln!("Generating a new local self-signed WebTransport certificate.");

            let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])
                .context("failed to create self-signed identity")?;

            identity
                .certificate_chain()
                .store_pemfile(CERT_FILE)
                .await
                .context("failed to store certificate")?;

            identity
                .private_key()
                .store_secret_pemfile(KEY_FILE)
                .await
                .context("failed to store private key")?;

            Ok(identity)
        }
    }
}

fn print_certificate_hash(identity: &Identity) {
    let hash = identity.certificate_chain().as_slice()[0]
        .hash()
        .fmt(Sha256DigestFmt::DottedHex)
        .to_string()
        .replace(':', "");
    println!("Certificate SHA-256 for browser serverCertificateHashes:");
    println!("{hash}");
}
