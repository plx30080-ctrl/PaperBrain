import Foundation

struct Note: Codable, Identifiable, Hashable {
    let id: UUID
    var userId: UUID
    var title: String
    var transcription: String?
    var organized: String?
    var summary: String?
    var keyPoints: [String]?
    var tags: [String]?
    var processingState: String
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case title
        case transcription
        case organized
        case summary
        case keyPoints = "key_points"
        case tags
        case processingState = "processing_state"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var isProcessing: Bool { processingState == "pending" || processingState == "processing" }
    var isDone: Bool { processingState == "done" }

    static func == (lhs: Note, rhs: Note) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
