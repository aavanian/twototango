// SPDX-License-Identifier: AGPL-3.0-only

import AVFoundation

/// Says the answer aloud on the GM's phone. Used on the main thread only.
final class Speech {
    private let synthesizer = AVSpeechSynthesizer()
    private var sessionReady = false

    /// Called at game start: the first real word then plays without the engine's start-up delay.
    func warm(lang: String) {
        prepareSession()
        let utterance = AVSpeechUtterance(string: " ")
        utterance.voice = AVSpeechSynthesisVoice(language: lang)
        utterance.volume = 0
        synthesizer.speak(utterance)
    }

    func say(_ text: String, lang: String) {
        prepareSession()
        synthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: lang)
        synthesizer.speak(utterance)
    }

    /// Playback, so the word is heard with the silent switch on; mixing, so music in
    /// the room keeps playing.
    private func prepareSession() {
        guard !sessionReady else { return }
        sessionReady = true
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
        try? session.setActive(true)
    }
}
