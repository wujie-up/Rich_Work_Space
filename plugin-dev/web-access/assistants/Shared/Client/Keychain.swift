import Foundation
import Security
import DeskLinkCore

// Device keys and paired host identities stay in this app's Keychain access group.
enum Keychain {
    static func read(_ account: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "work-desk.link",
            kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw LinkError.invalid("无法读取设备钥匙串：\(status)") }
        return item as? Data
    }

    static func write(_ account: String, _ data: Data) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "work-desk.link",
            kSecAttrAccount as String: account]
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else {
                throw LinkError.invalid("无法保存设备钥匙串")
            }
        } else if status != errSecSuccess {
            throw LinkError.invalid("无法更新设备钥匙串：\(status)")
        }
    }
}
