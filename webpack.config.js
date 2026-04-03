const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

const extensionConfig = {
  target: "node",
  mode: "none",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: {
    vscode: "commonjs vscode",
    "node-pty": "commonjs node-pty",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [
          /node_modules/,
          /\.test\.ts$/,
          /src\/test\//,
          /src\/\__tests__\//,
        ],
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
    ],
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log",
  },
};

const webviewConfig = {
  target: "web",
  mode: "none",
  entry: {
    main: "./src/webview/main.ts",
    dashboard: "./src/webview/dashboard-manager.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: (pathData) => {
      if (pathData.chunk.name === "main") {
        return "webview.js";
      }
      return "[name].js";
    },
  },
  resolve: {
    extensions: [".ts", ".js"],
    fallback: {
      path: false,
      fs: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [
          /node_modules/,
          /\.test\.ts$/,
          /src\/test\//,
          /src\/\__tests__\//,
        ],
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, "src/webview/*.css"),
          to: path.resolve(__dirname, "dist/[name][ext]"),
          globOptions: { ignore: [] },
        },
        {
          from: path.resolve(__dirname, "src/webview/*.html"),
          to: path.resolve(__dirname, "dist/[name][ext]"),
          globOptions: { ignore: [] },
        },
      ],
    }),
  ],
  devtool: "nosources-source-map",
};

module.exports = [extensionConfig, webviewConfig];
