// SPDX-License-Identifier: AGPL-3.0-only

import Foundation
import Network

/// The listeners players' and spectators' phones connect to, on the local network.
///
/// - HTTP on `httpPort` serves the same web bundle the app runs (Capacitor's `public`
///   folder), so a phone's browser opens the player page from the QR link.
/// - WebSocket on `wsPort` carries the game messages. Network.framework speaks the
///   WebSocket protocol on its own listener, so it gets a port of its own; the page
///   learns it from a meta tag added to index.html.
///
/// The ports are fixed so a phone that lost the GM (app killed, phone call) finds it
/// again at the same address when it retries. All state lives on one serial queue.
final class PhoneServer {
    struct Events {
        /// Where phones join, again after a restart or a network change ("" when offline).
        let ready: (String) -> Void
        let open: (String) -> Void
        let message: (String, String) -> Void
        let close: (String) -> Void
    }

    static let httpPort: UInt16 = 5170
    static let wsPort: UInt16 = 5171

    private let webRoot: URL
    private let events: Events
    private let queue = DispatchQueue(label: "twototango.phone-server")
    private var httpListener: NWListener?
    private var wsListener: NWListener?
    private var phones: [String: NWConnection] = [:]
    private var nextConn = 1
    private var restarting = false
    private var lastJoinBase = ""
    private let pathMonitor = NWPathMonitor()
    private var monitoring = false

    init(webRoot: URL, events: Events) {
        self.webRoot = webRoot
        self.events = events
    }

    /// Starts listening. Called again when the GM page reloads: the old page's
    /// connections are dropped so the phones reconnect to the new one.
    func start() -> String {
        queue.sync {
            if httpListener == nil {
                if !restarting { startListeners() }
            } else {
                dropPhones()
            }
            if !monitoring {
                monitoring = true
                pathMonitor.pathUpdateHandler = { [weak self] _ in self?.announceIfMoved() }
                pathMonitor.start(queue: queue)
            }
            lastJoinBase = joinBase()
            return lastJoinBase
        }
    }

    /// Back in the foreground: listeners suspended with the app may have died.
    func refresh() {
        queue.async {
            guard self.httpListener != nil || self.restarting else { return }
            if self.isListening(self.httpListener) && self.isListening(self.wsListener) {
                self.announceIfMoved()
            } else {
                self.restartSoon()
            }
        }
    }

    func send(_ conn: String, _ text: String) {
        queue.async {
            guard let connection = self.phones[conn] else { return }
            let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
            let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
            connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .idempotent)
        }
    }

    // MARK: - Listeners

    private func startListeners() {
        httpListener = makeListener(port: Self.httpPort, parameters: Self.tcpParameters()) { [weak self] in
            self?.serveHTTP($0)
        }
        wsListener = makeListener(port: Self.wsPort, parameters: Self.webSocketParameters()) { [weak self] in
            self?.acceptPhone($0)
        }
        if httpListener == nil || wsListener == nil { restartSoon() }
    }

    private func makeListener(port: UInt16, parameters: NWParameters, accept: @escaping (NWConnection) -> Void) -> NWListener? {
        guard let nwPort = NWEndpoint.Port(rawValue: port),
              let listener = try? NWListener(using: parameters, on: nwPort) else { return nil }
        listener.newConnectionHandler = accept
        listener.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.restartSoon() }
        }
        listener.start(queue: queue)
        return listener
    }

    private func isListening(_ listener: NWListener?) -> Bool {
        if case .ready = listener?.state { return true }
        return false
    }

    /// Tears both listeners down and brings them back a second later (port still
    /// held by the dying socket, network not up yet). Phones retry on their own.
    private func restartSoon() {
        guard !restarting else { return }
        restarting = true
        httpListener?.cancel()
        wsListener?.cancel()
        httpListener = nil
        wsListener = nil
        dropPhones()
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            self.restarting = false
            self.startListeners()
            self.lastJoinBase = self.joinBase()
            self.events.ready(self.lastJoinBase)
        }
    }

    private func announceIfMoved() {
        let base = joinBase()
        guard base != lastJoinBase else { return }
        lastJoinBase = base
        events.ready(base)
    }

    private static func tcpParameters() -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        // A phone that vanished without closing (battery, out of range) is noticed in
        // about 20 s, which is when the session's grace period starts.
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 10
        tcp.keepaliveInterval = 5
        tcp.keepaliveCount = 2
        let parameters = NWParameters(tls: nil, tcp: tcp)
        parameters.allowLocalEndpointReuse = true
        return parameters
    }

    private static func webSocketParameters() -> NWParameters {
        let parameters = tcpParameters()
        let webSocket = NWProtocolWebSocket.Options()
        webSocket.autoReplyPing = true
        webSocket.maximumMessageSize = 64 * 1024
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocket, at: 0)
        return parameters
    }

    // MARK: - Phones (WebSocket)

    private func acceptPhone(_ connection: NWConnection) {
        let conn = "n\(nextConn)"
        nextConn += 1
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.phones[conn] = connection
                self.events.open(conn)
                self.receive(conn, connection)
            case .failed, .cancelled:
                self.closePhone(conn)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receive(_ conn: String, _ connection: NWConnection) {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self, self.phones[conn] != nil else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if error != nil || (content == nil && metadata == nil) {
                return self.closePhone(conn)
            }
            switch metadata?.opcode {
            case .text?:
                self.events.message(conn, String(decoding: content ?? Data(), as: UTF8.self))
            case .close?:
                return self.closePhone(conn)
            default:
                break
            }
            self.receive(conn, connection)
        }
    }

    private func closePhone(_ conn: String) {
        guard let connection = phones.removeValue(forKey: conn) else { return }
        connection.cancel()
        events.close(conn)
    }

    private func dropPhones() {
        for conn in Array(phones.keys) { closePhone(conn) }
    }

    // MARK: - Web page (HTTP)

    private static let maxRequestHead = 16 * 1024

    private func serveHTTP(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(connection, buffer: Data())
    }

    private func receiveRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: Self.maxRequestHead) { [weak self] data, _, isComplete, error in
            guard let self else { return connection.cancel() }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(connection, head: String(decoding: buffer[..<end.lowerBound], as: UTF8.self))
            } else if error != nil || isComplete || buffer.count > Self.maxRequestHead {
                connection.cancel()
            } else {
                self.receiveRequest(connection, buffer: buffer)
            }
        }
    }

    private func respond(_ connection: NWConnection, head: String) {
        let requestLine = head.components(separatedBy: "\r\n").first ?? ""
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            return reply(connection, status: "400 Bad Request", type: "text/plain", body: Data(), headOnly: false, cache: false)
        }
        let method = parts[0]
        guard method == "GET" || method == "HEAD" else {
            return reply(connection, status: "405 Method Not Allowed", type: "text/plain", body: Data(), headOnly: false, cache: false)
        }
        guard let asset = asset(for: String(parts[1])) else {
            return reply(connection, status: "404 Not Found", type: "text/plain", body: Data(), headOnly: false, cache: false)
        }
        reply(connection, status: "200 OK", type: asset.type, body: asset.data, headOnly: method == "HEAD", cache: asset.immutable)
    }

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript",
        "css": "text/css",
        "svg": "image/svg+xml",
        "png": "image/png",
        "json": "application/json",
        "woff2": "font/woff2",
        "ico": "image/x-icon"
    ]

    /// Every route is the single-page app, as with the dev host.
    private func asset(for target: String) -> (data: Data, type: String, immutable: Bool)? {
        let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        let decoded = path.removingPercentEncoding ?? path
        let parts = decoded.split(separator: "/").map(String.init).filter { $0 != "." && $0 != ".." && !$0.isEmpty }
        var file = webRoot
        for part in parts { file.appendPathComponent(part) }
        var isDirectory: ObjCBool = false
        if parts.isEmpty || !FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory) || isDirectory.boolValue {
            file = webRoot.appendingPathComponent("index.html")
        }
        guard var data = try? Data(contentsOf: file) else { return nil }
        let isIndex = file.lastPathComponent == "index.html"
        if isIndex {
            let tag = "<meta name=\"ttt-ws-port\" content=\"\(Self.wsPort)\"></head>"
            data = Data(String(decoding: data, as: UTF8.self).replacingOccurrences(of: "</head>", with: tag).utf8)
        }
        // Vite names assets by content hash, so they never change under the same name.
        let immutable = parts.first == "assets"
        return (data, Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream", immutable && !isIndex)
    }

    private func reply(_ connection: NWConnection, status: String, type: String, body: Data, headOnly: Bool, cache: Bool) {
        let head = "HTTP/1.1 \(status)\r\n"
            + "Content-Type: \(type)\r\n"
            + "Content-Length: \(body.count)\r\n"
            + "Cache-Control: \(cache ? "public, max-age=31536000, immutable" : "no-store")\r\n"
            + "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        if !headOnly { out.append(body) }
        connection.send(content: out, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    // MARK: - Address

    /// The QR link uses the phone's IP address rather than a .local name: iOS no longer
    /// exposes a stable device name, and every browser opens an IP without mDNS.
    private func joinBase() -> String {
        guard let address = Self.lanAddress() else { return "" }
        return "http://\(address):\(Self.httpPort)"
    }

    /// Wi-Fi first, then the personal hotspot's bridge (the GM's phone hosting the network).
    static func lanAddress() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var found: [String: String] = [:]
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            found[String(cString: entry.ifa_name)] = String(cString: host)
        }
        if let wifi = found["en0"] { return wifi }
        if let hotspot = found["bridge100"] { return hotspot }
        return found.sorted { $0.key < $1.key }.first { $0.key.hasPrefix("en") || $0.key.hasPrefix("bridge") }?.value
    }
}
