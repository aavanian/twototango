// SPDX-License-Identifier: AGPL-3.0-only

import Foundation

/// The saved game (for resume after a call, a kill or a crash) and the play history,
/// as JSON files in Application Support. Writes are atomic, so a crash mid-write
/// leaves the previous file.
final class FileStore {
    static let names: Set<String> = ["game", "history"]

    private let queue = DispatchQueue(label: "twototango.files")
    private let directory: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("TwoToTango", isDirectory: true)

    func read(_ name: String) throws -> String? {
        try queue.sync {
            let url = file(name)
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            return try String(contentsOf: url, encoding: .utf8)
        }
    }

    /// nil deletes the file.
    func write(_ name: String, _ text: String?) throws {
        try queue.sync {
            let url = file(name)
            guard let text else {
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                return
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url, options: .atomic)
        }
    }

    private func file(_ name: String) -> URL {
        directory.appendingPathComponent("\(name).json")
    }
}
