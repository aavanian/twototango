// swift-tools-version: 5.9
// SPDX-License-Identifier: AGPL-3.0-only
import PackageDescription

// Package and product name are what the Capacitor CLI derives from the npm name
// (@twototango/ios-host), so `cap sync` can wire it into the app.
let package = Package(
    name: "TwototangoIosHost",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "TwototangoIosHost",
            targets: ["HostPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "HostPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/HostPlugin")
    ]
)
