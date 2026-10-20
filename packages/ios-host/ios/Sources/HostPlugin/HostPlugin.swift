// SPDX-License-Identifier: AGPL-3.0-only

import Capacitor
import Foundation
import UIKit

/// The GM app's native side. The game itself runs in the web page (Session in
/// packages/core); this plugin only moves bytes and talks to the device:
/// - the listeners players' phones connect to (PhoneServer),
/// - spoken answers (Speech), the idle timer, and a file store for resume and history.
/// The TypeScript side is apps/client/src/host/native.ts.
@objc(HostPlugin)
public class HostPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HostPlugin"
    public let jsName = "Host"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "warmSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise)
    ]

    private var server: PhoneServer?
    private let files = FileStore()
    private let speech = Speech()

    override public func load() {
        // Created here, never replaced: plugin methods and the foreground notification
        // run on different threads and both read it.
        if let webRoot = Bundle.main.url(forResource: "public", withExtension: nil) {
            server = PhoneServer(webRoot: webRoot, events: PhoneServer.Events(
                ready: { [weak self] base in self?.emit("ready", ["joinBase": base]) },
                open: { [weak self] conn in self?.emit("open", ["conn": conn]) },
                message: { [weak self] conn, text in self?.emit("message", ["conn": conn, "data": text]) },
                close: { [weak self] conn in self?.emit("close", ["conn": conn]) }))
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(willEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let server else { return call.reject("web assets missing from the app bundle") }
        call.resolve(["joinBase": server.start()])
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let conn = call.getString("conn"), let data = call.getString("data") else {
            return call.reject("conn and data are required")
        }
        server?.send(conn, data)
        call.resolve()
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), FileStore.names.contains(name) else {
            return call.reject("unknown file")
        }
        do {
            // No data key when there is no file: the page reads it as null.
            // An empty object, not resolve(): that one hands the page undefined.
            if let text = try files.read(name) { call.resolve(["data": text]) } else { call.resolve([:]) }
        } catch {
            call.reject("could not read \(name): \(error.localizedDescription)")
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), FileStore.names.contains(name) else {
            return call.reject("unknown file")
        }
        do {
            try files.write(name, call.getString("data"))
            call.resolve()
        } catch {
            call.reject("could not write \(name): \(error.localizedDescription)")
        }
    }

    @objc func warmSpeech(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? "en-GB"
        DispatchQueue.main.async { self.speech.warm(lang: lang) }
        call.resolve()
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else { return call.reject("text is required") }
        let lang = call.getString("lang") ?? "en-GB"
        DispatchQueue.main.async { self.speech.say(text, lang: lang) }
        call.resolve()
    }

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
        call.resolve()
    }

    @objc private func willEnterForeground() {
        server?.refresh()
    }

    private func emit(_ event: String, _ data: [String: Any]) {
        DispatchQueue.main.async { self.notifyListeners(event, data: data) }
    }
}
