import Foundation
import LolChatCore
import Testing
@testable import LolChatApp

@Suite("App model: chat window")
@MainActor
struct ChatModelTests {
    @Test func draftIsCappedLikeTheTUI() {
        let model = connectedModel()
        model.draft = String(repeating: "x", count: 600)
        #expect(model.draft.count == 500)
    }

    @Test func messageRowIdsAreStableAcrossTrimming() {
        let now = Date()
        var messages = Fixtures.messages(start: now)
        messages.append(messages[2])
        let rows = MessageRow.rows(messages)
        #expect(Set(rows.map(\.id)).count == rows.count)
        let trimmed = MessageRow.rows(Array(messages.dropFirst(1)))
        #expect(Array(rows.dropFirst(1)).map(\.id) == trimmed.map(\.id))
    }
}
