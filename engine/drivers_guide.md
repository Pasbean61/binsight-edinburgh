# EcoBin Edinburgh — Driver Portal & Route Collection Guide

This guide lists the demo truck logins for the City of Edinburgh communal-bin network and explains
how to use the driver dashboard to follow an optimised route. Trucks, drivers and plates are
placeholders created by the data generator, not real council vehicles.

---

## 1. Fleet Login Credentials

The demo fleet has **24 refuse collection vehicles** based at **Seafield Depot**. Log in with the
**Truck ID**. A truck that is not used in today's plan shows no route.

| Truck ID | Driver | Plate | Capacity |
|---|---|---|---|
| **`EDI-RCV-01`** | Driver 01 | RCV-01 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-02`** | Driver 02 | RCV-02 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-03`** | Driver 03 | RCV-03 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-04`** | Driver 04 | RCV-04 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-05`** | Driver 05 | RCV-05 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-06`** | Driver 06 | RCV-06 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-07`** | Driver 07 | RCV-07 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-08`** | Driver 08 | RCV-08 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-09`** | Driver 09 | RCV-09 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-10`** | Driver 10 | RCV-10 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-11`** | Driver 11 | RCV-11 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-12`** | Driver 12 | RCV-12 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-13`** | Driver 13 | RCV-13 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-14`** | Driver 14 | RCV-14 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-15`** | Driver 15 | RCV-15 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-16`** | Driver 16 | RCV-16 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-17`** | Driver 17 | RCV-17 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-18`** | Driver 18 | RCV-18 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-19`** | Driver 19 | RCV-19 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-20`** | Driver 20 | RCV-20 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-21`** | Driver 21 | RCV-21 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-22`** | Driver 22 | RCV-22 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-23`** | Driver 23 | RCV-23 | 60,000 L per trip, up to 3 trips |
| **`EDI-RCV-24`** | Driver 24 | RCV-24 | 60,000 L per trip, up to 3 trips |

Each trip starts at Seafield, collects stops until the truck is full, and returns to tip.
A route with several trips passes through the depot between them (shown as "Tip & reload").

---

## 2. Using the Driver Dashboard

### Step 1: Accessing the Portal & Logging In
1. Open the EcoBin Driver Portal URL: `http://localhost:5173/driver`.
2. You will be greeted by the clean, light-themed **Driver Access Portal** login screen.
3. Enter your assigned **Truck ID** (e.g., `EDI-RCV-03`) into the input field.
4. Click **Access Route Dashboard**.

### Step 2: Route Overview & Statistics
Once logged in, the dashboard loads your active optimized route:
- **Header**: Displays your name, assigned truck, and current date.
- **Stops Progress**: A progress bar showing the percentage of bins collected on this shift.
- **Key Statistics**: 
  - **Route Distance**: Total road distance in kilometers.
  - **Estimated Time**: Estimated duration of the shift.
  - **Next Stop**: Name and details of your immediate collection target.

### Step 3: Interactive Map Navigation
- An interactive, light-themed Leaflet map displays your complete snapped road route.
- **Markers**: 
  - **Depot**: Starting and ending point of the collection trip.
  - **Numbered Pins**: Order of bin stops along the optimized path.
  - **Colors**: Bins are color-coded by priority (Green = Low, Yellow = Medium, Red = Critical/Full).

### Step 4: Step-by-Step Collection
The sidebar displays your ordered list of assigned bin stops:
1. Drive to the **Next Stop** indicated at the top of the sidebar.
2. Once you arrive at the bin location, empty the physical bin into the truck.
3. On the dashboard, click **Empty Bin** for that stop.
4. The system will send a telemetry request to reset the bin's fill level to `0.0%` in the database.
5. The stop will update to a green **Collected** badge. This status persists even if you refresh the browser page.
6. The next bin in the sequence will automatically become your active target.

### Step 5: Reporting Maintenance / Blockages
If you arrive at a bin and cannot empty it due to physical damage or access blockages:
1. Click the **Report Issue** icon (red warning triangle) next to the bin in the stops list.
2. In the modal dialog:
   - Select the **Issue Type** (e.g., *Damaged Lid*, *Blocked Access*, *Sensor Failure*, *Vandalism*).
   - Enter additional details in the **Notes** field.
3. Click **Submit Alert**.
4. The bin is automatically put into **Maintenance** status and marked for dispatch to repair crews, skipping it from your active route.

### Step 6: Completing the Shift
1. After collecting all assigned bins, drive back to the **Depot** (final stop).
2. Click **Empty Bin** on the depot to finish the route.
3. When your shift is complete, click **Logout** in the top header to secure the session.
