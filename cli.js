#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Validates a packet image object.
 * @param {object} packetImage The packet image object to validate.
 * @returns {Array<string>} An array of validation errors, or an empty array if valid.
 */
function validatePacketSchema(packetImage) {
  const errors = [];

  if (!packetImage || typeof packetImage !== 'object') {
    errors.push('Packet image is not a valid JSON object.');
    return errors;
  }

  // Check top-level keys
  const requiredKeys = ['id', 'title', 'created', 'sourceContent'];
  const missingKeys = requiredKeys.filter(key => !(key in packetImage));
  if (missingKeys.length > 0) {
    errors.push(`Missing required top-level keys: ${missingKeys.join(', ')}.`);
  }

  // Check key types
  if (packetImage.id && typeof packetImage.id !== 'string') {
    errors.push('Key "id" must be a string.');
  }
  if (packetImage.title && typeof packetImage.title !== 'string') {
    errors.push('Key "title" must be a string.');
  }
  if (packetImage.created && typeof packetImage.created !== 'string') {
    errors.push('Key "created" must be a string.');
  }
  if (!Array.isArray(packetImage.sourceContent)) {
    errors.push('Key "sourceContent" must be an array.');
  }

  // Check for duplicate URLs
  if (Array.isArray(packetImage.sourceContent)) {
    const urls = new Set();
    const duplicates = new Set();

    function checkDuplicates(contentArray) {
      for (const item of contentArray) {
        if (item.url) {
          if (urls.has(item.url)) {
            duplicates.add(item.url);
          } else {
            urls.add(item.url);
          }
        }
        if (item.type === 'alternative' && item.alternatives) {
          checkDuplicates(item.alternatives);
        }
      }
    }

    checkDuplicates(packetImage.sourceContent);

    if (duplicates.size > 0) {
      errors.push(`Found duplicate URLs in content: ${Array.from(duplicates).join(', ')}.`);
    }
  }

  return errors;
}

/**
 * Validates if a packet is "winnable" by ensuring all required items are reachable.
 * @param {object} packetImage The packet image object to validate.
 * @returns {Array<string>} An array of winnability errors, or an empty array if valid.
 */
function validatePacketWinnability(packetImage) {
    const errors = [];

    // Fallback case: If no checkpoints are defined, the packet is trivially winnable.
    if (!packetImage.checkpoints || packetImage.checkpoints.length === 0) {
        return errors;
    }

    // 1. Initialization
    const requiredItems = new Set();
    packetImage.checkpoints.forEach(cp => {
        cp.requiredItems.forEach(item => {
            requiredItems.add(item.url); // Now only uses URL
        });
    });

    const unlockedItems = new Set(
        packetImage.sourceContent
            .filter(item => typeof item.revealedByMoment !== 'number')
            .map(item => item.url)
            .filter(Boolean)
    );

    const trippedMoments = new Set();
    let progressMadeInLoop = true;

    // 2. The Unlocking Loop
    while (progressMadeInLoop) {
        progressMadeInLoop = false;
        const newlyVisitedItems = [];

        for (const required of requiredItems) {
            if (unlockedItems.has(required)) {
                newlyVisitedItems.push(required);
                progressMadeInLoop = true;
            }
        }

        if (newlyVisitedItems.length > 0) {
            newlyVisitedItems.forEach(visited => requiredItems.delete(visited));

            const momentsToTrip = (packetImage.moments || [])
                .filter(moment => newlyVisitedItems.includes(moment.sourceUrl) && !trippedMoments.has(moment.id));

            momentsToTrip.forEach(moment => {
                trippedMoments.add(moment.id);
                const momentIndex = packetImage.moments.indexOf(moment);

                packetImage.sourceContent
                    .filter(item => item.revealedByMoment === momentIndex)
                    .forEach(item => unlockedItems.add(item.url));
            });
        }
    }

    // 3. Determining the Result
    if (requiredItems.size > 0) {
        errors.push('Packet is not winnable. The following required items are unreachable:');
        requiredItems.forEach(item => errors.push(`- ${item}`));
    }

    return errors;
}


/**
 * Main function to handle command-line input.
 */
function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const filename = args[1];

  if (!['validate', 'winnable'].includes(command) || !filename) {
    console.error('Usage: pkt <validate|winnable> <filename>');
    process.exit(1);
  }

  const filePath = path.resolve(filename);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found at ${filePath}`);
    process.exit(1);
  }

  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const packetImage = JSON.parse(fileContent);
    let errors = [];

    if (command === 'validate') {
        errors = validatePacketSchema(packetImage);
    } else if (command === 'winnable') {
        // A packet must be schema-valid before checking winnability
        errors = validatePacketSchema(packetImage);
        if (errors.length === 0) {
            errors = validatePacketWinnability(packetImage);
        }
    }

    if (errors.length === 0) {
      console.log(`✅ Success: Packet image "${filename}" is valid and completable.`);
      process.exit(0);
    } else {
      console.error(`❌ Validation failed for "${filename}":`);
      errors.forEach(err => console.error(`- ${err}`));
      process.exit(1);
    }
  } catch (parseError) {
    console.error(`Error: Could not parse file as JSON. ${parseError.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}