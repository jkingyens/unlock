// Rust Quest Packet - mirrors the JavaScript packet functionality

wit_bindgen::generate!({
    world: "packet",
    path: "../packet.wit",
});

struct QuestPacket;

impl Guest for QuestPacket {
    fn init() {
        use component::quest_v1::host_content::*;
        use component::quest_v1::host_quest_manager::*;
        
        // Register the google.com page as a visitable item
        register_item(
            &"google-item".to_string(),
            &"https://google.com".to_string(),
            &"Visit Google".to_string(),
            &"webpage".to_string()
        );
        
        // Register a task for the quest
        register_task(
            &"quest-1".to_string(),
            &"task-1".to_string(),
            &"Visit https://google.com".to_string()
        );
        
        // Notify the player that the quest has started
        notify_player(&"Rust Quest Started: Visit Google!".to_string());
    }
    
    fn on_visit(url: String) {
        use component::quest_v1::host_quest_manager::*;
        use component::quest_v1::engine_types::Status;
        
        // Check if the user visited google.com
        if url.contains("google.com") {
            update_task(&"quest-1".to_string(), &"task-1".to_string(), Status::Completed);
            notify_player(&"Rust Task Complete: Google visited!".to_string());
        }
    }
}

export!(QuestPacket);
