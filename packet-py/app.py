import wit_world
from wit_world.imports import host_quest_manager, host_content

class WitWorld(wit_world.WitWorld):
    def init(self):
        # Register the google.com page as a visitable item
        host_content.register_item("google-item", "https://google.com", "Visit Google", "webpage")
        
        host_quest_manager.register_task("quest-1", "task-1", "Visit https://google.com")
        host_quest_manager.notify_player("Python Quest Started: Visit Google!")

    def on_visit(self, url: str):
        if "google.com" in url:
            host_quest_manager.update_task("quest-1", "task-1", wit_world.engine_types.Status.COMPLETED)
            host_quest_manager.notify_player("Python Task Complete: Google visited!")
