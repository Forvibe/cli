import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectRawDependencies } from "../../src/analyzers/sdk-scanner.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("collectRawDependencies", () => {
  it("swift-app: pods from Podfile, ios_imports from .swift source (unfiltered - includes non-SDK_MAP imports like UIKit)", () => {
    const deps = collectRawDependencies(fixturePath("swift-app"), "swift");

    expect(deps.pods).toContain("AppsFlyerFramework");
    expect(deps.pods).toContain("Google-Mobile-Ads-SDK");
    expect(deps.ios_imports).toContain("StoreKit");
    expect(deps.ios_imports).toContain("UIKit");

    // android side is not applicable for a pure-swift stack.
    expect(deps.android_imports).toEqual([]);
    expect(deps.gradle).toEqual([]);
  });

  it("swift-app: all 9 buckets are always present, and pods/ios_imports are deduped + sorted", () => {
    const deps = collectRawDependencies(fixturePath("swift-app"), "swift");

    expect(Object.keys(deps).sort()).toEqual(
      [
        "npm", "pub", "pods", "spm", "gradle",
        "nuget", "upm", "ios_imports", "android_imports",
      ].sort()
    );
    expect(deps.pods).toEqual([...deps.pods].sort());
    expect(deps.pods).toEqual([...new Set(deps.pods)]);
    expect(deps.ios_imports).toEqual([...deps.ios_imports].sort());
    expect(deps.ios_imports).toEqual([...new Set(deps.ios_imports)]);
  });

  it("flutter-app: pub contains the pubspec dependencies", () => {
    const deps = collectRawDependencies(fixturePath("flutter-app"), "flutter");

    expect(deps.pub).toContain("google_mobile_ads");
    expect(deps.pub).toContain("health");
    expect(deps.pub).toContain("in_app_purchase");
  });

  it("flutter-app: gradle is empty - android/app/build.gradle has no external dependency declarations, and the top-level android/build.gradle's `classpath` entries are buildscript tooling, not app SDKs", () => {
    const deps = collectRawDependencies(fixturePath("flutter-app"), "flutter");

    expect(deps.gradle).toEqual([]);
  });

  it("flutter-app: ios_imports/android_imports are empty (Dart source, no native scan for this stack)", () => {
    const deps = collectRawDependencies(fixturePath("flutter-app"), "flutter");

    expect(deps.ios_imports).toEqual([]);
    expect(deps.android_imports).toEqual([]);
  });

  it("flutter-app: pods is empty - fixture has no ios/Podfile", () => {
    const deps = collectRawDependencies(fixturePath("flutter-app"), "flutter");

    expect(deps.pods).toEqual([]);
  });

  it("kotlin-app: gradle contains the module's dependency coordinates in full 'group:artifact' form only (no separate bare-artifact entry)", () => {
    const deps = collectRawDependencies(fixturePath("kotlin-app"), "kotlin");

    // Documented emitted form: the collector emits ONE canonical coordinate
    // per dependency - the full "group:artifact" string - and relies on the
    // registry matcher's bare-vs-coordinate bridging rule (matchGradle in
    // registry.ts) to match a bare pattern against the artifact segment of
    // that string. It deliberately does NOT also push a separate bare
    // artifact-name entry (unlike the legacy addCoord's dual-push shape in
    // getDependencies() above it): doing so would make a bare pattern like
    // "play-services-ads" match this ONE real dependency twice (once as the
    // bare entry, once as the artifact segment of the full entry),
    // producing two redundant matched_coordinates for a single SDK - see
    // registry.test.ts's end-to-end describe block for the regression this
    // guards against.
    expect(deps.gradle).toEqual([
      "com.android.billingclient:billing",
      "com.google.android.gms:play-services-ads",
    ]);

    // The top-level build.gradle's `classpath 'com.android.tools.build:gradle:...'`
    // and `classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:..."` are
    // buildscript tooling, not shipped SDKs, and must NOT appear.
    expect(deps.gradle).not.toContain("com.android.tools.build:gradle");
    expect(deps.gradle).not.toContain("org.jetbrains.kotlin:kotlin-gradle-plugin");
  });

  it("kotlin-app: android_imports is non-empty, because MainActivity.kt DOES have import statements (raw/unfiltered - not gated by the legacy scan's curated framework-prefix allowlist)", () => {
    const deps = collectRawDependencies(fixturePath("kotlin-app"), "kotlin");

    // MainActivity.kt imports android.os.Bundle and
    // androidx.appcompat.app.AppCompatActivity - neither is one of the
    // legacy scan's curated framework prefixes (com.google.android.gms.ads
    // etc.), which is exactly why this raw collector does NOT reuse that
    // allowlist: the registry matcher needs the actual imported symbols to
    // do its own prefix matching against arbitrary registry patterns.
    expect(deps.android_imports).toEqual([
      "android.os.Bundle",
      "androidx.appcompat.app.AppCompatActivity",
    ]);
  });

  it("expo-app: npm contains the package.json dependencies", () => {
    const deps = collectRawDependencies(fixturePath("expo-app"), "expo");

    expect(deps.npm).toContain("expo-camera");
    expect(deps.npm).toContain("react-native-purchases");
  });

  it("expo-app: pods/gradle are empty - fixture has no ios/ or android/ directory", () => {
    const deps = collectRawDependencies(fixturePath("expo-app"), "expo");

    expect(deps.pods).toEqual([]);
    expect(deps.gradle).toEqual([]);
  });

  it("unity-app: upm contains the Packages/manifest.json dependency keys", () => {
    const deps = collectRawDependencies(fixturePath("unity-app"), "unity");

    expect(deps.upm).toContain("com.unity.ads");
    expect(deps.upm).toContain("com.google.ads.mobile");
    expect(deps.upm).toContain("com.unity.purchasing");
  });

  it("unity-app: gradle contains the Assets/Plugins/Android AAR basename (extension stripped)", () => {
    const deps = collectRawDependencies(fixturePath("unity-app"), "unity");

    expect(deps.gradle).toContain("applovin-sdk-12.1.0");
  });

  it("unity-app: pods is empty - fixture has no Assets/Plugins/iOS/", () => {
    const deps = collectRawDependencies(fixturePath("unity-app"), "unity");

    expect(deps.pods).toEqual([]);
  });

  it("kmp-app: gradle contains the androidApp module's play-services-ads coordinate (full 'group:artifact' form, reached across modules from rootDir)", () => {
    const deps = collectRawDependencies(fixturePath("kmp-app"), "kmp");

    expect(deps.gradle).toContain("com.google.android.gms:play-services-ads");
  });

  it("kmp-app: ios_imports contains SwiftUI (scanned from iosApp/**/*.swift)", () => {
    const deps = collectRawDependencies(fixturePath("kmp-app"), "kmp");

    expect(deps.ios_imports).toContain("SwiftUI");
  });

  it("objc-app (stack swift): ios_imports contains GoogleMobileAds AND FirebaseCore from the .m source (ObjC import scanning)", () => {
    const deps = collectRawDependencies(fixturePath("objc-app"), "swift");

    expect(deps.ios_imports).toContain("GoogleMobileAds");
    expect(deps.ios_imports).toContain("FirebaseCore");
  });

  it("an unknown stack returns all-empty buckets without crashing", () => {
    const deps = collectRawDependencies(fixturePath("swift-app"), "unknown");

    expect(deps).toEqual({
      npm: [],
      pub: [],
      pods: [],
      spm: [],
      gradle: [],
      nuget: [],
      upm: [],
      ios_imports: [],
      android_imports: [],
    });
  });

  it("a nonexistent rootDir returns all-empty buckets without crashing", () => {
    const deps = collectRawDependencies(fixturePath("does-not-exist"), "kotlin");

    expect(deps.gradle).toEqual([]);
    expect(deps.android_imports).toEqual([]);
  });

  describe("synthetic fixtures (behavior not covered by the committed test/fixtures/* apps)", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("dotnet-maui: nuget contains .csproj PackageReference ids (root + nested)", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-collect-deps-maui-"));
      writeFileSync(
        path.join(dir, "MyApp.csproj"),
        `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Plugin.InAppBilling" Version="7.0.1" />
    <PackageReference Include="CommunityToolkit.Maui" Version="9.0.0" />
  </ItemGroup>
</Project>
`
      );

      const deps = collectRawDependencies(dir, "dotnet-maui");

      expect(deps.nuget).toEqual(["CommunityToolkit.Maui", "Plugin.InAppBilling"]);
    });

    it("flutter: pods is populated from a nested ios/Podfile when one is present", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-collect-deps-flutter-pods-"));
      mkdirSync(path.join(dir, "ios"), { recursive: true });
      writeFileSync(
        path.join(dir, "ios", "Podfile"),
        `platform :ios, '15.0'\ntarget 'Runner' do\n  pod 'Firebase/Analytics'\nend\n`
      );

      const deps = collectRawDependencies(dir, "flutter");

      expect(deps.pods).toEqual(["Firebase/Analytics"]);
    });

    it("react-native: npm/pods/gradle all resolve via the shared expo/react-native/capacitor case", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-collect-deps-rn-"));
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { "react-native-purchases": "^8.0.0" } })
      );
      mkdirSync(path.join(dir, "ios"), { recursive: true });
      writeFileSync(path.join(dir, "ios", "Podfile"), `pod 'RNPurchases'\n`);

      const deps = collectRawDependencies(dir, "react-native");

      expect(deps.npm).toEqual(["react-native-purchases"]);
      expect(deps.pods).toEqual(["RNPurchases"]);
    });

    it("swift: spm slugs are collected from Package.swift and a pbxproj repositoryURL, both lowercased", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-collect-deps-spm-"));
      writeFileSync(
        path.join(dir, "Package.swift"),
        `// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Fixture",
  dependencies: [
    .package(url: "https://github.com/duckduckgo/PurchasesKit.git", from: "1.0.0")
  ]
)
`
      );
      mkdirSync(path.join(dir, "Fixture.xcodeproj"), { recursive: true });
      writeFileSync(
        path.join(dir, "Fixture.xcodeproj", "project.pbxproj"),
        `// !$*UTF8*$!
{
	objects = {
		A1 /* XCRemoteSwiftPackageReference "GoogleMobileAds" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/googleads/swift-package-manager-google-mobile-ads.git";
		};
	};
}
`
      );

      const deps = collectRawDependencies(dir, "swift");

      // Both come out lowercased, per the registry matcher's spm comparison contract.
      expect(deps.spm).toEqual([
        "purchaseskit",
        "swift-package-manager-google-mobile-ads",
      ]);
    });
  });
});
