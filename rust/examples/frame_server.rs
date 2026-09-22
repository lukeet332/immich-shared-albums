// frame_server.rs — speaks the isa/2 frame codec over TCP so the independent JavaScript oracle in
// demo/e2e/iroh-client.mjs can drive it. Interop with THAT, not merely with our own round trip.
use immich_shared_albums::p2p::frame::{
    frame, read_frame, RequestHeader, ResponseHeader, HEADER_FRAME_LIMIT, JSON_BODY_LIMIT,
};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(9500);
    let listener = TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    println!("listening {port}");

    loop {
    let (mut stream, _) = match listener.accept().await { Ok(v) => v, Err(_) => break };
    tokio::spawn(async move {
    // 1. The request header frame, at the fixed 64 KiB cap.
    let header_bytes = match read_frame(&mut stream, HEADER_FRAME_LIMIT).await.expect("read header") {
        Ok(bytes) => bytes,
        Err(over) => {
            eprintln!("header over limit: {}", over.declared);
            return;
        }
    };
    let header: RequestHeader = serde_json::from_slice(&header_bytes).expect("header json");

    // 2. The body frame. A bodyless request still sends a four-byte zero, which reads back empty.
    let body_limit = 1024 * 1024;
    let body_bytes = match read_frame(&mut stream, body_limit).await.expect("read body") {
        Ok(bytes) => bytes,
        Err(over) => {
            let head = ResponseHeader::json(413);
            stream.write_all(&frame(&serde_json::to_vec(&head).unwrap())).await.unwrap();
            let payload = serde_json::json!({
                "error": format!("frame of {} bytes exceeds the {}-byte limit", over.declared, body_limit),
                "code": "body_too_large",
            });
            stream.write_all(payload.to_string().as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
            return;
        }
    };

    // 3. Answer in the shape the oracle reads: a JSON header frame, then a JSON body to FIN.
    let parsed_body: Option<serde_json::Value> =
        if body_bytes.is_empty() { None } else { serde_json::from_slice(&body_bytes).ok() };

    let reply = serde_json::json!({
        "protocol": 2,
        "echo_path": header.path,
        "echo_range": header.range,
        "echo_mapping": header.mapping,
        "echo_body": parsed_body,
        "body_len": body_bytes.len(),
    });
    let head = ResponseHeader::json(200);
    stream.write_all(&frame(&serde_json::to_vec(&head).unwrap())).await.unwrap();
    stream.write_all(reply.to_string().as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
    let _ = JSON_BODY_LIMIT;
    });
    }
}
