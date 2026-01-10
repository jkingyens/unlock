const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
    });

    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addExecutable(.{
        .name = "packet",
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = false,
    });

    lib.entry = .disabled;
    lib.rdynamic = true;
    b.installArtifact(lib);
}
