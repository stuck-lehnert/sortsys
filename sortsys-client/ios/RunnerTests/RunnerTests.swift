import Flutter
import UIKit
import XCTest

@testable import Runner

final class RunnerTests: XCTestCase {
  func testApplicationIdentity() {
    let applicationBundle = Bundle(for: AppDelegate.self)

    XCTAssertEqual(applicationBundle.bundleIdentifier, "app.sortsys.client")
    XCTAssertEqual(
      applicationBundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
      "sortsys"
    )
  }

  func testApplicationKeepsDefaultTransportSecurity() {
    let applicationBundle = Bundle(for: AppDelegate.self)

    XCTAssertNil(applicationBundle.object(forInfoDictionaryKey: "NSAppTransportSecurity"))
  }

}
