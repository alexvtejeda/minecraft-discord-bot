plugins {
    java
}

group = "mc.lobbybridge"
version = "1.0.0"

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    // Matches the Paper build mc-host runs (apps/agent/src/lobby/paper.ts).
    compileOnly("io.papermc.paper:paper-api:26.3.build.147-beta")
    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
}

tasks.test {
    useJUnitPlatform()
}

tasks.jar {
    archiveFileName.set("lobby-bridge.jar")
}
