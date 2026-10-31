import Foundation
import Testing
@testable import AutoChatApp

@Suite("Icon")
struct IconRendererTests {
    @Test func rendersAPNG() {
        let png = IconRenderer.render(pixels: 64)
        #expect((png?.count ?? 0) > 100)
        #expect(png?.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
    }
}
