//! Zig 0.16 build for pixelpipe.
//!
//! Targets:
//!   zig build              # build all
//!   zig build render-cli   # standalone CLI that renders text → PNG (verifies pipeline)
//!   zig build test         # run renderer tests

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Find libdeflate. Allow override via LIBDEFLATE_DIR env var; otherwise
    // expect the user to either vendor it or have it on the system path.
    const libdeflate_dir = b.graph.environ_map.get("LIBDEFLATE_DIR");

    const render_exe = b.addExecutable(.{
        .name = "render_cli",
        .root_module = b.createModule(.{
            .root_source_file = b.path("render_cli.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    render_exe.root_module.link_libc = true;
    if (libdeflate_dir) |dir| {
        render_exe.root_module.addIncludePath(.{ .cwd_relative = b.fmt("{s}/include", .{dir}) });
        render_exe.root_module.addLibraryPath(.{ .cwd_relative = b.fmt("{s}/lib", .{dir}) });
    } else {
        // Try Homebrew on macOS arm64 by default
        render_exe.root_module.addIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
        render_exe.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
    }
    render_exe.root_module.linkSystemLibrary("deflate", .{});

    b.installArtifact(render_exe);

    const run_render = b.addRunArtifact(render_exe);
    if (b.args) |args| run_render.addArgs(args);
    const run_step = b.step("render-cli", "Run render_cli to test the pipeline");
    run_step.dependOn(&run_render.step);

    // Unit tests
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("menlo5.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run renderer tests");
    test_step.dependOn(&run_tests.step);
}
