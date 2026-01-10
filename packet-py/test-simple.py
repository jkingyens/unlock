import wit_world
from wit_world.imports import host_test

class WitWorld(wit_world.WitWorld):
    def init(self):
        host_test.log("Test message")
