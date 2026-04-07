import Foundation
import UIKit
import Supabase

/// Handles Supabase Storage uploads and signed-URL generation.
@MainActor
final class StorageService {
    static let shared = StorageService()
    private var client: SupabaseClient { SupabaseService.shared.client }
    private let bucket = "note-images"

    private init() {}

    /// Upload JPEG data to `<userId>/<noteId>/<pageIndex>.jpg`.
    func uploadNoteImage(_ data: Data, userId: UUID, noteId: UUID, pageIndex: Int) async throws {
        let path = "\(userId.uuidString)/\(noteId.uuidString)/\(pageIndex).jpg"
        try await client.storage
            .from(bucket)
            .upload(path: path, file: data, options: FileOptions(contentType: "image/jpeg", upsert: true))
    }

    /// Returns a 1-hour signed URL for a stored image path.
    func signedURL(for storagePath: String) async throws -> URL {
        try await client.storage
            .from(bucket)
            .createSignedURL(path: storagePath, expiresIn: 3600)
    }

    func deleteImages(paths: [String]) async throws {
        try await client.storage
            .from(bucket)
            .remove(paths: paths)
    }

    // MARK: - Image helpers

    /// Resize a UIImage so neither dimension exceeds `maxSide`, preserving aspect ratio.
    static func resize(_ image: UIImage, maxSide: CGFloat = 1568) -> UIImage {
        let size = image.size
        guard max(size.width, size.height) > maxSide else { return image }
        let scale = maxSide / max(size.width, size.height)
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: newSize)) }
    }

    /// Crop `image` to a normalized rect (0–1 coords) and return JPEG data.
    static func crop(_ image: UIImage, normalizedRect: CGRect) -> Data? {
        let size = image.size
        let rect = CGRect(
            x: normalizedRect.origin.x * size.width,
            y: normalizedRect.origin.y * size.height,
            width: normalizedRect.size.width * size.width,
            height: normalizedRect.size.height * size.height
        )
        guard let cgCrop = image.cgImage?.cropping(to: rect) else { return nil }
        return UIImage(cgImage: cgCrop).jpegData(compressionQuality: 0.85)
    }

    /// Convert a UIImage to JPEG base64 data-URL (for edge function payloads).
    static func toDataURL(_ image: UIImage, quality: CGFloat = 0.85) -> String? {
        guard let data = image.jpegData(compressionQuality: quality) else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }
}
