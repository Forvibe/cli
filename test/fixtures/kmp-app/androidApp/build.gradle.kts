plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.forvibe.fixture.kmp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.forvibe.fixture.kmp"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    implementation(project(":shared"))
    implementation("com.google.android.gms:play-services-ads:23.0.0")
}
