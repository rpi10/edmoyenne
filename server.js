const express = require('express');
const { Builder, By, until, WebDriverWait } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Function to parse and normalize grades
function parseNotes(notesColumn) {
    const grades = [];
    if (notesColumn) {
        const noteEntries = notesColumn.split("\n").filter(note => note.trim() !== '');
        
        for (let note of noteEntries) {
            note = note.trim();
            if (note) {
                try {
                    // Handle grades with coefficients
                    let coef = 1.0;
                    if (note.includes("(")) {
                        const [gradePart, coefPart] = note.split("(");
                        coef = parseFloat(coefPart.replace(")", "").trim());
                        note = gradePart.trim();
                    }

                    // Handle grades with denominators
                    let grade, denom = 20.0;
                    if (note.includes("/")) {
                        [grade, denom] = note.split("/").map(x => parseFloat(x.trim().replace(",", ".")));
                    } else {
                        grade = parseFloat(note.replace(",", "."));
                    }

                    grades.push({ grade, denom, coef });
                } catch (error) {
                    console.warn('Error parsing grade:', note, error);
                }
            }
        }
    }
    return grades;
}

// Function to add spaces between name and teacher
function formatDisciplineName(discipline) {
    // Replace hyphen with spaced hyphen, but only between letters
    return discipline.replace(/(\D)-(\D)/g, '$1 - $2');
}

app.post('/scrape-grades', async (req, res) => {
    const { username, password } = req.body;
    let driver;

    try {
        // Set up Firefox options
        const options = new firefox.Options();
        // Uncomment to run headless
        // options.addArguments('-headless');

        // Create WebDriver instance
        driver = await new Builder()
            .forBrowser('firefox')
            .setFirefoxOptions(options)
            .build();

        // Increase timeouts
        driver.manage().setTimeouts({
            implicit: 10000,  // 10 seconds implicit wait
            pageLoad: 30000,  // 30 seconds page load timeout
            script: 30000     // 30 seconds script timeout
        });

        // Navigate to Ecole Directe login page
        await driver.get('https://www.ecoledirecte.com/E/8683/Notes');

        // More comprehensive login process
        const usernameField = await driver.wait(
            until.elementLocated(By.css('input[name="username"]')), 
            15000
        );
        await usernameField.sendKeys(username);

        const passwordField = await driver.wait(
            until.elementLocated(By.css('input[name="password"]')), 
            15000
        );
        await passwordField.sendKeys(password);
        
        // Click login button with explicit wait
        const loginButton = await driver.wait(
            until.elementLocated(By.css('button[type="submit"]')), 
            15000
        );
        await loginButton.click();

        // Wait for page to load after login
        await driver.wait(async () => {
            try {
                // Try to find multiple possible elements that indicate successful login
                const elements = await driver.findElements(By.css('.table, .notes-container, #notes-table'));
                return elements.length > 0;
            } catch (error) {
                return false;
            }
        }, 30000);

        // More flexible table selection
        let notesTable;
        try {
            notesTable = await driver.wait(
                until.elementLocated(
                    By.css('.table, .notes-table, #notes-table, table[class*="notes"]')
                ), 
                20000
            );
        } catch (error) {
            // If table not found, take screenshot for debugging
            const screenshot = await driver.takeScreenshot();
            console.error('Could not find notes table. Screenshot saved.');
            require('fs').writeFileSync('debug-screenshot.png', screenshot, 'base64');
            throw new Error('Could not locate notes table. Check login or page structure.');
        }

        // Find all rows in the notes table
        const rows = await notesTable.findElements(By.css('tr'));

        const processedData = [];
        let currentSubject = null;
        let subjectGrades = [];
        let subjectCoef = [];
        let subjectAverages = []; // Array to store all subject averages

        for (let row of rows) {
            try {
                const cells = await row.findElements(By.tagName('td'));
                if (cells.length > 0) {
                    const discipline = formatDisciplineName(await cells[0].getText());
                    const gradeElements = await cells[3].findElements(By.css('.valeur'));
                    
                    // Start new subject if different from current
                    if (discipline !== currentSubject && discipline.trim() !== '') {
                        // Calculate and add average for previous subject
                        if (currentSubject && subjectGrades.length > 0) {
                            const totalScore = subjectGrades.reduce((sum, g) => 
                                sum + (g.grade / g.denom * 20) * g.coef, 0);
                            const totalCoef = subjectCoef.reduce((sum, c) => sum + c, 0);
                            const average = totalScore / totalCoef;
                            subjectAverages.push(average); // Store the subject average
                            processedData.push([currentSubject, "", `Moyenne: ${average.toFixed(2)}`]);
                        }
                        
                        // Reset for new subject
                        currentSubject = discipline;
                        subjectGrades = [];
                        subjectCoef = [];
                        processedData.push([discipline, "", ""]);
                    }

                    // Process grades
                    for (const gradeElement of gradeElements) {
                        const gradeText = await gradeElement.getText();
                        if (!gradeText.trim()) continue;

                        // Parse grade using the original format
                        const grades = parseNotes(gradeText);
                        for (let grade of grades) {
                            subjectGrades.push(grade);
                            subjectCoef.push(grade.coef);
                            processedData.push(["", `${gradeText}`, ""]);
                        }
                    }
                }
            } catch (cellError) {
                console.warn('Error processing row:', cellError);
            }
        }

        // Calculate average for the last subject
        if (currentSubject && subjectGrades.length > 0) {
            const totalScore = subjectGrades.reduce((sum, g) => 
                sum + (g.grade / g.denom * 20) * g.coef, 0);
            const totalCoef = subjectCoef.reduce((sum, c) => sum + c, 0);
            const average = totalScore / totalCoef;
            subjectAverages.push(average); // Store the last subject average
            processedData.push([currentSubject, "", `Moyenne: ${average.toFixed(2)}`]);
        }

        // Calculate overall average (average of subject averages)
        if (subjectAverages.length > 0) {
            const overallAverage = subjectAverages.reduce((sum, avg) => sum + avg, 0) / subjectAverages.length;
            processedData.push(["", "", ""]);  // Empty line for spacing
            processedData.push(["Moyenne Générale", "", `${overallAverage.toFixed(2)}/20`]);
        }

        res.json(processedData);

    } catch (error) {
        console.error('Scraping error:', error);
        res.status(500).json({ 
            error: error.toString(),
            message: 'Failed to scrape grades. Check your credentials and network connection.'
        });
    } finally {
        if (driver) {
            await driver.quit();
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});