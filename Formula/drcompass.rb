class Drcompass < Formula
  desc "Disaster recovery planning studio for AWS multi-region DR"
  homepage "https://github.com/jonehb11/drcompass"
  url "https://github.com/jonehb11/drcompass/archive/refs/tags/v0.3.0.tar.gz"
  sha256 "c105595ee81f797a066aec3f8acca3e072433e78e868b6df1e1b5cc7bd3c5e2d"
  license "MIT"
  version "0.3.0"

  depends_on "node"

  def install
    # No build step: install the app tree into libexec, fetch runtime deps,
    # and expose the CLI through an env script that pins Homebrew's node.
    libexec.install Dir["*"]
    cd libexec do
      system "npm", "install", "--omit=dev", "--no-audit", "--no-fund"
    end
    chmod 0755, libexec/"bin/drcompass.js"
    (bin/"drcompass").write_env_script libexec/"bin/drcompass.js",
      PATH: "#{Formula["node"].opt_bin}:$PATH"
  end

  def caveats
    <<~EOS
      Run `drcompass` to start the UI at http://localhost:4517
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/drcompass --version")
  end
end
