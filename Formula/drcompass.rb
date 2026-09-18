class Drcompass < Formula
  desc "Disaster recovery planning studio for AWS multi-region DR"
  homepage "https://github.com/jonehb11/drcompass"
  url "https://github.com/jonehb11/drcompass/archive/refs/tags/v0.7.3.tar.gz"
  sha256 "3a4e2810eb2e6134d13a50641d11e0b34eab164eade22e5ee3eab347268605fa"
  license "MIT"
  version "0.7.3"

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

    # Exercise the storage path too: a formula that only proves --version works
    # would still pass with a broken install tree.
    ENV["DRCOMPASS_HOME"] = testpath/"drcompass-home"
    system bin/"drcompass", "init", "brewtest", "--name", "Brew Test"
    assert_match "brewtest", shell_output("#{bin}/drcompass list")
    assert_predicate testpath/"drcompass-home/workspaces/brewtest/workspace.json", :exist?
  end
end
