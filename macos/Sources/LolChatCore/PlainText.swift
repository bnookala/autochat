import Foundation

public enum PlainText {
    /// Peer text is already sanitized by the core; this is a last line of defense before
    /// display. It drops control and bidi-override characters. Callers must still render it
    /// with `Text(verbatim:)` so nothing is parsed as markdown or turned into links.
    public static func clean(_ s: String, keepNewlines: Bool = false) -> String {
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            let v = u.value
            if v == 0x0A { out.append(keepNewlines ? u : " "); continue }
            if v == 0x09 { out.append(" "); continue }
            if v < 0x20 || (v >= 0x7F && v < 0xA0) { continue }
            if (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || v == 0x200E || v == 0x200F { continue }
            out.append(u)
        }
        return String(out)
    }
}
