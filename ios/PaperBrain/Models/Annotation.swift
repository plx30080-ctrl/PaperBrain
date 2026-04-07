import Foundation

struct Annotation: Codable, Identifiable {
    let id: UUID
    let noteId: UUID
    let imageId: UUID?
    let shapeType: ShapeType
    let shapeData: ShapeData
    let tag: String?
    var regionContent: String?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case noteId = "note_id"
        case imageId = "image_id"
        case shapeType = "shape_type"
        case shapeData = "shape_data"
        case tag
        case regionContent = "region_content"
        case createdAt = "created_at"
    }

    enum ShapeType: String, Codable, CaseIterable {
        case rect, ellipse, freehand
    }

    /// All coordinates are normalized to 0–1 relative to the image dimensions.
    struct ShapeData: Codable {
        // rect / ellipse
        var x: Double?
        var y: Double?
        var width: Double?
        var height: Double?
        // freehand: array of [x, y] pairs
        var points: [[Double]]?
    }
}
