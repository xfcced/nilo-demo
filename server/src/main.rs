mod config;
mod game;
mod game_net;
mod net;

use anyhow::{Context, Result};
use config::{load_game_config, GameConfig};
use game::room::Room;
use game::server_host::ServerHost;
use std::env;
use std::sync::Arc;
use tracing::info;
use wtransport::tls::Sha256DigestFmt;
use wtransport::Identity;

const DEFAULT_CERT_FILE: &str = "certs/localhost.pem";
const DEFAULT_KEY_FILE: &str = "certs/localhost-key.pem";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nilo_demo_server=info,info".into()),
        )
        .init();

    let config = Arc::new(load_game_config()?);
    let settings = ServerSettings::from_env(&config)?;
    let identity = load_or_create_identity(&settings).await?;
    print_certificate_hash(&identity);

    let room = Arc::new(Room::new(Arc::clone(&config)));
    let server = ServerHost::new(settings.port, identity, room, Arc::clone(&config))?;
    let addr = server.local_addr()?;

    info!("server ready");
    println!(
        "WebTransport URL: https://localhost:{}{}",
        addr.port(),
        config.network.web_transport_path
    );

    server.serve().await
}

struct ServerSettings {
    port: u16,
    cert_file: String,
    key_file: String,
    uses_default_cert_files: bool,
}

impl ServerSettings {
    fn from_env(config: &GameConfig) -> Result<Self> {
        let port = match env::var("PORT") {
            Ok(value) => value
                .parse::<u16>()
                .with_context(|| format!("invalid PORT value: {value}"))?,
            Err(_) => config.network.default_port,
        };

        let cert_file = env::var("TLS_CERT_FILE").unwrap_or_else(|_| DEFAULT_CERT_FILE.to_string());
        let key_file = env::var("TLS_KEY_FILE").unwrap_or_else(|_| DEFAULT_KEY_FILE.to_string());
        let uses_default_cert_files =
            cert_file == DEFAULT_CERT_FILE && key_file == DEFAULT_KEY_FILE;

        Ok(Self {
            port,
            cert_file,
            key_file,
            uses_default_cert_files,
        })
    }
}

async fn load_or_create_identity(settings: &ServerSettings) -> Result<Identity> {
    match Identity::load_pemfiles(&settings.cert_file, &settings.key_file).await {
        Ok(identity) => Ok(identity),
        Err(error) => {
            if !settings.uses_default_cert_files {
                return Err(error).with_context(|| {
                    format!(
                        "failed to load TLS certificate files: {} and {}",
                        settings.cert_file, settings.key_file
                    )
                });
            }

            eprintln!("Could not load existing certificate files: {error}");
            eprintln!("Generating a new local self-signed WebTransport certificate.");

            let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])
                .context("failed to create self-signed identity")?;

            identity
                .certificate_chain()
                .store_pemfile(&settings.cert_file)
                .await
                .context("failed to store certificate")?;

            identity
                .private_key()
                .store_secret_pemfile(&settings.key_file)
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
