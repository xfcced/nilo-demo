use anyhow::{bail, Context, Result};
use tokio::sync::mpsc;
use wtransport::error::StreamReadExactError;
use wtransport::{RecvStream, SendStream};

pub type OutboundFrameSender = mpsc::UnboundedSender<Vec<u8>>;
pub type OutboundFrameReceiver = mpsc::UnboundedReceiver<Vec<u8>>;

const FRAME_HEADER_BYTES: usize = 4;
const MAX_FRAME_BYTES: usize = 1024 * 1024;

pub fn outbound_frame_queue() -> (OutboundFrameSender, OutboundFrameReceiver) {
    mpsc::unbounded_channel()
}

pub struct FramedStreamReader {
    recv_stream: RecvStream,
}

impl FramedStreamReader {
    pub fn new(recv_stream: RecvStream) -> Self {
        Self { recv_stream }
    }

    pub async fn read_frame(&mut self) -> Result<Option<Vec<u8>>> {
        let mut length_bytes = [0_u8; FRAME_HEADER_BYTES];
        match self.recv_stream.read_exact(&mut length_bytes).await {
            Ok(_) => {}
            Err(StreamReadExactError::FinishedEarly(0)) => return Ok(None),
            Err(error) => return Err(error).context("failed to read frame length"),
        }

        let length = u32::from_be_bytes(length_bytes) as usize;
        if length > MAX_FRAME_BYTES {
            bail!("received frame exceeds max size: {length}");
        }

        let mut payload = vec![0_u8; length];
        self.recv_stream
            .read_exact(&mut payload)
            .await
            .context("failed to read frame payload")?;

        Ok(Some(payload))
    }
}

pub async fn write_framed_messages(
    mut send_stream: SendStream,
    mut receiver: OutboundFrameReceiver,
) -> Result<()> {
    while let Some(payload) = receiver.recv().await {
        if payload.len() > MAX_FRAME_BYTES {
            bail!("outbound frame exceeds max size: {}", payload.len());
        }

        send_stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .await
            .context("failed to write frame length")?;
        send_stream
            .write_all(&payload)
            .await
            .context("failed to write frame payload")?;
    }

    Ok(())
}
