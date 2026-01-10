// Zig Quest Packet - mirrors the JavaScript/Rust packet functionality
const std = @import("std");

// Component Model bindings (simplified manual bindings)
// In production, you'd use wit-bindgen for Zig when available

// Export functions for the Quest API
export fn init() void {
    // Register the google.com page as a visitable item
    registerItem(
        "google-item",
        "https://google.com",
        "Visit Google",
        "webpage"
    );
    
    // Register a task for the quest
    registerTask(
        "quest-1",
        "task-1",
        "Visit https://google.com"
    );
    
    // Notify the player that the quest has started
    notifyPlayer("Zig Quest Started: Visit Google!");
}

export fn onVisit(url_ptr: [*]const u8, url_len: usize) void {
    const url = url_ptr[0..url_len];
    
    // Check if the user visited google.com
    if (std.mem.indexOf(u8, url, "google.com") != null) {
        updateTask("quest-1", "task-1", 2); // 2 = Completed status
        notifyPlayer("Zig Task Complete: Google visited!");
    }
}

// Import host functions (these will be provided by the Component Model adapter)
extern "component:quest-v1/host-content" fn registerItem(
    id_ptr: [*]const u8,
    id_len: usize,
    url_ptr: [*]const u8,
    url_len: usize,
    title_ptr: [*]const u8,
    title_len: usize,
    type_ptr: [*]const u8,
    type_len: usize,
) void;

extern "component:quest-v1/host-quest-manager" fn registerTask(
    qid_ptr: [*]const u8,
    qid_len: usize,
    tid_ptr: [*]const u8,
    tid_len: usize,
    desc_ptr: [*]const u8,
    desc_len: usize,
) void;

extern "component:quest-v1/host-quest-manager" fn updateTask(
    qid_ptr: [*]const u8,
    qid_len: usize,
    tid_ptr: [*]const u8,
    tid_len: usize,
    status: u32,
) void;

extern "component:quest-v1/host-quest-manager" fn notifyPlayer(
    msg_ptr: [*]const u8,
    msg_len: usize,
) void;

// Helper wrappers to convert string literals to pointer+length
fn registerItem(id: []const u8, url: []const u8, title: []const u8, item_type: []const u8) void {
    registerItem(id.ptr, id.len, url.ptr, url.len, title.ptr, title.len, item_type.ptr, item_type.len);
}

fn registerTask(qid: []const u8, tid: []const u8, desc: []const u8) void {
    registerTask(qid.ptr, qid.len, tid.ptr, tid.len, desc.ptr, desc.len);
}

fn updateTask(qid: []const u8, tid: []const u8, status: u32) void {
    updateTask(qid.ptr, qid.len, tid.ptr, tid.len, status);
}

fn notifyPlayer(msg: []const u8) void {
    notifyPlayer(msg.ptr, msg.len);
}
