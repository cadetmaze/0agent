class ZeroAgent < Formula
  desc "The judgment-native AI agent by Only Reason"
  homepage "https://onlyreason.ai"
  url "https://registry.npmjs.org/0agent/-/0agent-0.1.0.tgz"
  sha256 "REPLACE_WITH_ACTUAL_SHA256_AFTER_PUBLISHING"
  license "MIT"
  version "0.1.0"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "0.1.0", shell_output("#{bin}/0agent --version")
  end
end
