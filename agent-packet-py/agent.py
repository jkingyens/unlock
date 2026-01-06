import wit_world as _wit_world

class WitWorld(_wit_world.WitWorld):
    def run(self, code: str) -> str:
        if code == "init":
            return "Python Agent Initialized"
        
        # Match JS logic: evaluate the code string.
        scope = {}
        try:
            exec(code, scope)
            return "Python Execution Success" 
        except Exception as e:
            return f"Error: {str(e)}"
