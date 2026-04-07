import Foundation

struct Relation: Codable, Identifiable {
    let id: UUID
    let fromId: UUID
    let toId: UUID
    let score: Double
    let reason: String?
    let manual: Bool
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case fromId = "from_id"
        case toId = "to_id"
        case score
        case reason
        case manual
        case createdAt = "created_at"
    }

    func otherNoteId(relativeTo noteId: UUID) -> UUID {
        fromId == noteId ? toId : fromId
    }
}
