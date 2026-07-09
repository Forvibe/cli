plugins {
    kotlin("multiplatform")
    id("com.android.library")
}

kotlin {
    androidTarget()
    iosX64()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        val commonMain by getting {
            dependencies {
            }
        }
    }
}

android {
    namespace = "com.forvibe.fixture.kmp.shared"
    compileSdk = 34
}
