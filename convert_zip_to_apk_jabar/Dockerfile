FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV GRADLE_USER_HOME=/root/.gradle
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/gradle/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip zip git wget openjdk-17-jdk nodejs npm \
    build-essential python3 && rm -rf /var/lib/apt/lists/*

# Official Android command-line tools download.
RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools && \
    curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip -o /tmp/cmd.zip && \
    unzip -q /tmp/cmd.zip -d ${ANDROID_SDK_ROOT}/cmdline-tools && \
    mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest && \
    rm /tmp/cmd.zip

RUN yes | sdkmanager --licenses >/dev/null || true && \
    sdkmanager \
      "platform-tools" \
      "platforms;android-35" \
      "build-tools;35.0.0"

RUN curl -fsSL https://services.gradle.org/distributions/gradle-8.11.1-bin.zip -o /tmp/gradle.zip && \
    unzip -q /tmp/gradle.zip -d /opt && \
    mv /opt/gradle-8.11.1 /opt/gradle && \
    rm /tmp/gradle.zip

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
EXPOSE 8080
CMD ["npm","start"]
