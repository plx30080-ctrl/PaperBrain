import Foundation

struct Profile: Codable, Identifiable {
    let id: UUID
    var displayName: String?
    var claudeModel: String
    var handwritingContext: String?
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case claudeModel = "claude_model"
        case handwritingContext = "handwriting_context"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    static let availableModels: [String] = [
        "claude-opus-4-5",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
    ]
}
