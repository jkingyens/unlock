// C Quest Packet Implementation
// This file implements the exported functions defined in packet.h
#include "packet.h"
#include <string.h>

// Implement the init function
void exports_packet_init(void) {
    // Register the google.com page as a visitable item
    packet_string_t id, url, title, type;
    packet_string_set(&id, "google-item");
    packet_string_set(&url, "https://google.com");
    packet_string_set(&title, "Visit Google");
    packet_string_set(&type, "webpage");
    component_quest_v1_host_content_register_item(&id, &url, &title, &type);
    
    // Register a task for the quest
    packet_string_t qid, tid, desc;
    packet_string_set(&qid, "quest-1");
    packet_string_set(&tid, "task-1");
    packet_string_set(&desc, "Visit https://google.com");
    component_quest_v1_host_quest_manager_register_task(&qid, &tid, &desc);
    
    // Notify the player that the quest has started
    packet_string_t msg;
    packet_string_set(&msg, "C Quest Started: Visit Google!");
    component_quest_v1_host_quest_manager_notify_player(&msg);
}

// Implement the on_visit function
void exports_packet_on_visit(packet_string_t *url) {
    // Check if the user visited google.com
    // Create a null-terminated string for strstr
    char url_buf[1024];
    size_t len = url->len < 1023 ? url->len : 1023;
    memcpy(url_buf, url->ptr, len);
    url_buf[len] = '\0';
    
    if (strstr(url_buf, "google.com") != NULL) {
        packet_string_t qid, tid;
        packet_string_set(&qid, "quest-1");
        packet_string_set(&tid, "task-1");
        component_quest_v1_host_quest_manager_update_task(
            &qid, 
            &tid, 
            COMPONENT_QUEST_V1_ENGINE_TYPES_STATUS_COMPLETED
        );
        
        packet_string_t complete_msg;
        packet_string_set(&complete_msg, "C Task Complete: Google visited!");
        component_quest_v1_host_quest_manager_notify_player(&complete_msg);
    }
}
