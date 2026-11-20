# Nature Genetics: published Methods paragraphs

Paragraphs from Nature Genetics research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

Animal care and use was conducted in accordance with institutional guidelines and relevant regulatory standards. In vivo experiments were performed using male NCI SCID/NCr athymic nude mice (strain code 561, Charles River), CD1 mice (Charles River), CD rats (Charles River) and Crbn^V380E/I391V C57BL/6 mice, which were generously provided by B. L. Ebert (Dana-Farber Cancer Institute). All experiments were initiated using male animals aged 5–8 weeks. Mice and rats were housed in pathogen-free barrier facilities under standard conditions: 12 h light–dark cycle, ambient temperature of 18–23 °C and humidity of 40–60%. The maximum tumor size permitted by the IACUC was 2.0 cm in any dimension or a total tumor volume of 2,000 mm^3. This threshold was not exceeded in any animal during the course of the study.

Source: "Targeting histone H2B acetylated enhanceosomes via p300/CBP degradation in prostate cancer", Nature Genetics (2025), PMC12513837, CC BY 4.0.

## Example 2

On the first subset, we use the Rfam seed alignments as input to RNAalifold. To assess the robustness of the analyses to the alignment procedure, we additionally realigned the sequences in the seed alignments using Clustal-Omega (v1.2.4)[63] and MAFFT (v7.525)[64]. For the second subset, we performed sequence alignments using both Clustal-Omega and MAFFT, limiting the alignments to a maximum of 1,000 sequences (by aligning the PDB sequence to the top 999 nhmmer hits) to reduce computation time. On both subsets and from each alignment, a base-pair probability matrix corresponding to the predicted RNA structure was generated using RNAalifold available through the ViennaRNA (v2.6.4) package[65]. RNAalifold was run in the following two modes: using the default energy model (command: RNAalifold -p) and with RIBOSUM scoring (command: RNAalifold -p -r).

Source: "Nucleotide dependency analysis of genomic language models detects functional elements", Nature Genetics (2025), PMC12513839, CC BY 4.0.

## Example 3

RAD21^AID-expressing mESCs were first differentiated into epiblast stem cells by culturing them on dishes coated with 10 ng ml^−1 fibronectin (Merck Millipore), in N2B27 supplemented with 20 ng ml^−1 Activin A and 12 ng ml^−1 fibroblast growth factor 2 (FGF2) (PeproTech). Epiblast stem cells were further differentiated into NPCs by seeding 0.5–1 × 10^5 cells per cm^2 to fibronectin-coated dishes in N2B27 without growth factors. After 5 d, cells were dissociated with 0.5 × TrypLE (Thermo Fisher Scientific) and seeded to 0.1% gelatinized tissue culture plates in N2B27 supplemented with 10 ng ml^−1 FGF2 and 10 ng ml^−1 epithelial growth factor (PeproTech). NPCs were cultured in 0.1% gelatin-coated plates in N2B27 supplemented with 10 ng ml^−1 FGF2 and 10 ng ml^−1 epithelial growth factor.

Source: "Disentangling the architectural and non-architectural functions of CTCF and cohesin in gene regulation", Nature Genetics (2025), PMC12695661, CC BY 4.0.

## Example 4

For all cell lines, we obtained heterozygous insertions of the repeat arrays, allowing us to track one pair of green and far-red spots in the cells. For the L2 cell line, the CuOx150 array was inserted homozygously, resulting in two distinct far-red spots, while the TetOx96 cassette only integrated in a single allele. Upon sequencing of the L2 clone, we found a plasmid fragment of 396 bp integrated within the inserted exogenous sequence, at the 3′ end of the CuO repeats. This sequence contained a lac operon and promoter, Gateway attB2 sites and a catabolite activator protein binding site. In the T1 cell line, a small fraction of cells retained the antibiotic resistance genes after Cre and FLP recombinations, as assessed by PCR amplification of the nonrecombined alleles.

Source: "Uniform dynamics of cohesin-mediated loop extrusion in living human cells", Nature Genetics (2025), PMC12695666, CC BY 4.0.

## Example 5

We chose to use PCA rather than confirmatory factor analysis (CFA) for studying the dimensionality of educational fields for several reasons. First, PCA involves fewer assumptions than CFA. Although CFA models latent factors assumed to represent real traits measured by field choices, PCA simply reduces the dimensionality of the data by finding axes that explain maximum variation. In addition, CFA might require the somewhat ad-hoc addition of crossloadings based on modification indices to achieve a good fit, whereas PCA does not involve model-fit considerations. Second, the limited number of possible fields (ten indicators) makes PCA more suitable. CFA is ideally designed for studying latent factors that can be measured by an extensive, potentially infinite, number of indicators, which is not the case here.

Source: "Genetic associations with educational fields", Nature Genetics (2025), PMC12695639, CC BY 4.0.

## Example 6

Multivariable regression models were constructed using the functions betareg (for proportional burden) and lm (for immune dNdS). Sample type (gland/bulk for FF–WGS and superficial tumor/IM/node for FFPE–PS), tissue type (adenoma/cancer), immune escape (escape/weak-escape/no-escape) and patient were encoded as categorical variables; purity as a continuous variable. For Extended Data Fig. 10, sample type and patient were encoded as categorical variables and all immune infiltrate values handled as continuous variables (unit: number per epithelial cell). Results were visualized using the plot_summs function from the package jtools, omitting the full list of coefficients assigned to patients (as well as sample type for Extended Data Fig. 10a) to make the visuals easier to interpret. Instead, on Fig. 5a,b, the smallest and largest patient-associated coefficients were identified and plotted to highlight the range of coefficients.

Source: "Epigenetically driven and early immune evasion in colorectal cancer evolution", Nature Genetics (2025), PMC12695633, CC BY 4.0.
