import Foundation
import React

@objc(AppConfig)
final class AppConfig: NSObject, RCTBridgeModule {
  static func moduleName() -> String! {
    "AppConfig"
  }

  static func requiresMainQueueSetup() -> Bool {
    false
  }

  func constantsToExport() -> [AnyHashable: Any]! {
    let info = Bundle.main.infoDictionary ?? [:]
    return [
      "API_BASE_URL": info["MobileApiBaseUrl"] as? String ?? "",
      "CHART_WEB_BASE_URL": info["MobileChartWebBaseUrl"] as? String ?? "",
      "BUILD_TYPE": info["MobileBuildType"] as? String ?? "",
    ]
  }
}
