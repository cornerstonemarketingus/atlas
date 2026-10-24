import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
const read = path => readFileSync(new URL("../"+path,import.meta.url),"utf8");
test("pinned Capacitor runtime and every iOS build target agree on supported deployment",()=>{
 const pkg=JSON.parse(read("package.json"));assert.match(pkg.dependencies["@capacitor/core"],/^8\./);
 const minimum=Number(read("ios/App/Podfile").match(/platform :ios, '(\d+\.\d+)'/)[1]);assert.ok(minimum>=15,"Capacitor 8 requires iOS 15+");
 const targets=[...read("ios/App/App.xcodeproj/project.pbxproj").matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(match=>Number(match[1]));assert.ok(targets.length>=2);assert.ok(targets.every(target=>target===minimum),"project and target settings match CocoaPods");
});
test("Android SDK, Gradle wrapper and plugin versions form the Capacitor 8 toolchain",()=>{
 const vars=read("android/variables.gradle");const number=key=>Number(vars.match(new RegExp(key+" = (\\d+)"))[1]);
 assert.ok(number("minSdkVersion")>=24);assert.ok(number("targetSdkVersion")>=36);assert.ok(number("compileSdkVersion")>=number("targetSdkVersion"));
 assert.match(read("android/build.gradle"),/com.android.tools.build:gradle:8\.13\./);assert.match(read("android/gradle/wrapper/gradle-wrapper.properties"),/gradle-8\.14\.3-all\.zip/);
 const manifest=read("android/app/src/main/AndroidManifest.xml");assert.match(manifest,/configChanges="[^"\n]*\|density/);assert.match(manifest,/configChanges="[^"\n]*\|navigation/);
});
test("iOS scene lifecycle is registered and forwards cold, warm and universal links",()=>{
 const scene=read("ios/App/App/SceneDelegate.swift");const app=read("ios/App/App/AppDelegate.swift");const plist=read("ios/App/App/Info.plist");const project=read("ios/App/App.xcodeproj/project.pbxproj");
 assert.match(plist,/UIApplicationSceneManifest/);assert.match(plist,/\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate/);
 assert.match(app,/configurationForConnecting/);assert.match(app,/config.delegateClass = SceneDelegate.self/);
 for(const callback of ["willConnectTo: session, options: connectionOptions","openURLContexts: URLContexts","continue: userActivity"])assert.ok(scene.includes(callback),callback);
 assert.match(scene,/rootViewController = CAPBridgeViewController\(\)/);assert.match(scene,/makeKeyAndVisible\(\)/);
 for(const marker of ["SceneDelegate.swift in Sources","path = SceneDelegate.swift","/* SceneDelegate.swift */,"])assert.ok(project.includes(marker),marker);
});

test("app-bound iOS bridge permits only its bundled localhost origin",()=>{
 const config=JSON.parse(read("capacitor.config.json"));
 assert.equal(config.ios.limitsNavigationsToAppBoundDomains,true);
 const plist=read("ios/App/App/Info.plist");
 const domains=plist.match(/<key>WKAppBoundDomains<\/key>\s*<array>([\s\S]*?)<\/array>/);
 assert.ok(domains,"WebKit message handlers require an explicit app-bound domain declaration");
 assert.deepEqual([...domains[1].matchAll(/<string>(.*?)<\/string>/g)].map(match=>match[1]),["localhost"]);
});

test("native smoke metadata is debug-only and requires explicit process opt-in",()=>{
 const scene=read("ios/App/App/SceneDelegate.swift");
 const guarded=scene.match(/#if DEBUG([\s\S]*?)#endif/);
 assert.ok(guarded);assert.ok(guarded[1].includes('environment["ATLAS_NATIVE_SMOKE"] == "1"'));
 assert.equal(scene.replace(guarded[0], "").includes("evaluateJavaScript"),false);
 assert.ok(guarded[1].includes("error != nil"));assert.equal(guarded[1].includes("localizedDescription"),false);
});
