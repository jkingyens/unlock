# Packet v0 MVP WIT Interface Proposal

This document defines a v0 WIT interface for a "Packet" that acts as the controller for the User Interface. Ideally, the Wasm world contains all the logic to render cards, handle events, and track progress.

## Concept
*   **Host (Extension)**: Provides capabilities to render UI (Cards), store State, and emit Events.
*   **Guest (Packet Agent)**: Contains the business logic. It tells the Host what to display and reacts to User actions.

## WIT Definition (`packet-v0.wit`)

```wit
package local:packet-v0;

// 1. Types: specific to the UI domain
interface types {
    // Unique identifier for a card in the UI
    type card-id = string;

    // Status of a visual item
    enum status {
        pending,
        in-progress,
        completed,
        failed,
        skipped
    }

    // A visual "Card" to display in the sidebar
    record card {
        id: card-id,
        title: string,
        description: string,
        // Initial status
        status: status,
        // Actions available on this card (e.g., "Run", "View")
        actions: list<action>,
    }

    record action {
        id: string,
        label: string,
        // visual hint: primary, secondary, danger
        style: string, 
    }
}

// 2. Host Capabilities: What the Agent can ask the Extension to do
interface host-ui {
    use types.{card, card-id, status};

    // Adds a new card to the packet's view
    add-card: func(c: card);

    // Updates the status of an existing card
    update-status: func(id: card-id, s: status);

    // Updates the text or details of a card
    update-details: func(id: card-id, title: string, description: string);
    
    // Shows a toast or notification to the user
    notify: func(message: string, level: string);
}

// 3. Guest Logic: What the Extension calls on the Agent
world packet-logic {
    use types.{card-id};

    // Interfaces the Host provides to the Guest
    import host-ui;

    // --- Exports (The Agent's implementation) ---

    // Called when the packet is first initialized or resumed
    // Guest should use this to `add-card` for initial state.
    export start: func();

    // Called when the user clicks an action button on a card
    export on-action: func(cid: card-id, action-id: string);

    // Called when an external event happens (e.g., tab update, optional)
    export on-browser-event: func(event-type: string, payload: string);
}
```

## Example Workflow

1.  **Boot**:
    *   Extension loads Wasm.
    *   Extension calls `guest.start()`.
    *   Guest calls `host-ui.add-card({ id: "task-1", title: "Research", ... })`.
    *   Guest calls `host-ui.add-card({ id: "task-2", title: "Write Code", ... })`.

2.  **User Interaction**:
    *   User sees "Research" card with "Start" button.
    *   User clicks "Start".
    *   Extension calls `guest.on-action("task-1", "start-action")`.

3.  **Reaction**:
    *   Guest logic receives `on-action`.
    *   Guest calls `host-ui.update-status("task-1", in-progress)`.
    *   Guest performs some work (maybe HTTP or just internal logic).
    *   Guest calls `host-ui.update-status("task-1", completed)`.

## Data Flow: Guest to Host Rendering
The Wasm World provides rendering data by **pushing** structured data to the Host via the `host-ui` imports.

1.  **Definition**: The structure of the data is defined in `record card` (Types).
2.  **Transport**: The WIT Component Model automatically serializes this structure from the Guest language (e.g., Python Dict/Class) to the Host language (JavaScript Object).
3.  **Rendering**: The Host receives the JavaScript Object and uses it to generate DOM elements in the Sidebar.

### Python Example
In `agent-python/logic.py`:
```python
from wit_world import host_ui, types

class WitWorld(wit_world.WitWorld):
    def start(self):
        # 1. Define the Card Data
        my_card = types.Card(
            id="task-1",
            title="Analyze Packet",
            description="Reading metadata...",
            status=types.Status.PENDING,
            actions=[
                types.Action(id="run", label="Start Analysis", style="primary")
            ]
        )
        
        # 2. Push Data to Host
        host_ui.add_card(my_card)
```

